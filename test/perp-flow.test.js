import { expect } from "chai";
import hre from "hardhat";

const M = 10n ** 6n; // 1 USDR (6 decimals)
const PRICE = 100n * M; // 100 USDR per contract
const MARKET = 1n;

// market params
const INITIAL_BPS = 2000n; // 20% -> 5x max leverage
const MAINT_BPS = 1000n; // 10%
const MAKER_FEE = 10n; // 0.10%
const TAKER_FEE = 20n; // 0.20%
const LIQ_FEE = 100n; // 1.00%
const BPS = 10_000n;

async function expectCustomError(promise, errorName) {
  try {
    await promise;
    expect.fail(`expected custom error ${errorName}`);
  } catch (error) {
    expect(String(error)).to.contain(errorName);
  }
}

async function deployPerpFixture(connection) {
  const { ethers, networkHelpers } = connection;
  const [admin, operator, alice, bob, carol] = await ethers.getSigners();

  const Mock = await ethers.getContractFactory("MockStablecoin");
  const usdr = await Mock.deploy("USD Real Estate", "USDR", 6);

  const Oracle = await ethers.getContractFactory("NavOracle");
  // maxDeviation 50%, staleness ~31 years (effectively off for tests)
  const oracle = await Oracle.deploy(
    admin.address,
    admin.address,
    5000n,
    1_000_000_000n,
  );

  const Insurance = await ethers.getContractFactory("InsuranceFund");
  const insurance = await Insurance.deploy(admin.address, usdr.target);

  const Clearing = await ethers.getContractFactory("PerpClearing");
  const clearing = await Clearing.deploy(
    admin.address,
    usdr.target,
    oracle.target,
    insurance.target,
    operator.address,
  );

  await insurance
    .connect(admin)
    .grantRole(await insurance.DRAWER_ROLE(), clearing.target);

  // seed an initialised market on both the oracle and the clearing house
  await oracle.connect(admin).initializeMarket(MARKET, PRICE);
  await clearing
    .connect(admin)
    .addMarket(MARKET, INITIAL_BPS, MAINT_BPS, MAKER_FEE, TAKER_FEE, LIQ_FEE);

  // fund the insurance fund
  await usdr.mint(admin.address, 100_000n * M);
  await usdr.connect(admin).approve(insurance.target, 100_000n * M);
  await insurance.connect(admin).fund(50_000n * M);

  const { chainId } = await ethers.provider.getNetwork();
  const domain = {
    name: "WeBlockPerp",
    version: "1",
    chainId,
    verifyingContract: clearing.target,
  };
  const types = {
    Order: [
      { name: "trader", type: "address" },
      { name: "marketId", type: "uint256" },
      { name: "isBuy", type: "bool" },
      { name: "price", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "marginBps", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "expiry", type: "uint256" },
      { name: "reduceOnly", type: "bool" },
    ],
  };

  const now = await networkHelpers.time.latest();
  let nonce = 0n;
  function makeOrder(trader, isBuy, overrides = {}) {
    return {
      trader: trader.address,
      marketId: MARKET,
      isBuy,
      price: overrides.price ?? PRICE,
      amount: overrides.amount ?? 10n,
      marginBps: overrides.marginBps ?? INITIAL_BPS,
      nonce: overrides.nonce ?? nonce++,
      expiry: overrides.expiry ?? BigInt(now + 3600),
      reduceOnly: overrides.reduceOnly ?? false,
    };
  }
  async function signOrder(signer, order) {
    const sig = await signer.signTypedData(domain, types, order);
    return sig;
  }
  function trade(maker, makerSig, taker, takerSig, fillAmount, fillPrice) {
    return { maker, makerSig, taker, takerSig, fillAmount, fillPrice };
  }

  async function deposit(trader, amount) {
    await usdr.mint(trader.address, amount);
    await usdr.connect(trader).approve(clearing.target, amount);
    await clearing.connect(trader).deposit(amount);
  }

  return {
    ethers,
    networkHelpers,
    admin,
    operator,
    alice,
    bob,
    carol,
    usdr,
    oracle,
    insurance,
    clearing,
    makeOrder,
    signOrder,
    trade,
    deposit,
  };
}

// Helper: settle a single long(maker=buyer) vs short(taker=seller) trade.
async function openLongShort(fx, longSigner, shortSigner, qty, price) {
  const buy = fx.makeOrder(longSigner, true, { amount: qty, price });
  const sell = fx.makeOrder(shortSigner, false, { amount: qty, price });
  const buySig = await fx.signOrder(longSigner, buy);
  const sellSig = await fx.signOrder(shortSigner, sell);
  await fx.clearing
    .connect(fx.operator)
    .settleTrades([fx.trade(buy, buySig, sell, sellSig, qty, price)]);
}

describe("PerpClearing", function () {
  it("deposits and withdraws free collateral", async function () {
    const fx = await deployPerpFixture(await hre.network.connect());
    const { clearing, usdr, alice, deposit } = fx;

    await deposit(alice, 1000n * M);
    expect(await clearing.balanceOf(alice.address)).to.equal(1000n * M);

    await clearing.connect(alice).withdraw(400n * M);
    expect(await clearing.balanceOf(alice.address)).to.equal(600n * M);
    expect(await usdr.balanceOf(alice.address)).to.equal(400n * M);

    await expectCustomError(
      clearing.connect(alice).withdraw(601n * M),
      "InsufficientCollateral",
    );
  });

  it("opens equal & opposite positions and books margin + fees", async function () {
    const fx = await deployPerpFixture(await hre.network.connect());
    const { clearing, alice, bob, deposit } = fx;

    await deposit(alice, 1000n * M);
    await deposit(bob, 1000n * M);

    await openLongShort(fx, alice, bob, 10n, PRICE);

    const notional = 10n * PRICE; // 1000 USDR
    const margin = (notional * INITIAL_BPS) / BPS; // 200 USDR
    const makerFee = (notional * MAKER_FEE) / BPS; // 1 USDR
    const takerFee = (notional * TAKER_FEE) / BPS; // 2 USDR

    const aPos = await clearing.getPosition(alice.address, MARKET);
    const bPos = await clearing.getPosition(bob.address, MARKET);
    expect(aPos[0]).to.equal(10n); // long
    expect(bPos[0]).to.equal(-10n); // short
    expect(aPos[1]).to.equal(PRICE); // avg entry
    expect(aPos[2]).to.equal(margin);
    expect(bPos[2]).to.equal(margin);

    // maker = alice (buyer), taker = bob (seller)
    expect(await clearing.balanceOf(alice.address)).to.equal(
      1000n * M - margin - makerFee,
    );
    expect(await clearing.balanceOf(bob.address)).to.equal(
      1000n * M - margin - takerFee,
    );
    expect(await clearing.protocolFees()).to.equal(makerFee + takerFee);
  });

  it("averages the entry price when increasing a position", async function () {
    const fx = await deployPerpFixture(await hre.network.connect());
    const { clearing, oracle, admin, alice, bob, carol, deposit } = fx;

    await deposit(alice, 1000n * M);
    await deposit(bob, 1000n * M);
    await deposit(carol, 1000n * M);

    // alice longs 5 @100 (vs bob); price rises; alice adds 5 @120 (vs carol, a
    // fresh short so the counterparty stays solvent). Avg entry = 110, size 10.
    await openLongShort(fx, alice, bob, 5n, PRICE);
    const higher = 120n * M;
    await oracle.connect(admin).publishPrice(MARKET, higher);
    await openLongShort(fx, alice, carol, 5n, higher);

    const aPos = await clearing.getPosition(alice.address, MARKET);
    expect(aPos[0]).to.equal(10n); // size
    expect(aPos[1]).to.equal(110n * M); // weighted avg entry (5*100 + 5*120)/10
  });

  it("realises profit/loss as a zero-sum on close", async function () {
    const fx = await deployPerpFixture(await hre.network.connect());
    const { clearing, oracle, admin, alice, bob, deposit } = fx;

    await deposit(alice, 1000n * M);
    await deposit(bob, 1000n * M);
    await openLongShort(fx, alice, bob, 10n, PRICE);

    const aAfterOpen = await clearing.balanceOf(alice.address);
    const bAfterOpen = await clearing.balanceOf(bob.address);

    // price rises to 110; close at 110 (alice sells, bob buys back)
    const newPrice = 110n * M;
    await oracle.connect(admin).publishPrice(MARKET, newPrice);

    // closing trade: bob buys (maker), alice sells (taker), both reduceOnly
    const buy = fx.makeOrder(bob, true, {
      amount: 10n,
      price: newPrice,
      reduceOnly: true,
    });
    const sell = fx.makeOrder(alice, false, {
      amount: 10n,
      price: newPrice,
      reduceOnly: true,
    });
    const buySig = await fx.signOrder(bob, buy);
    const sellSig = await fx.signOrder(alice, sell);
    await clearing
      .connect(fx.operator)
      .settleTrades([fx.trade(buy, buySig, sell, sellSig, 10n, newPrice)]);

    expect((await clearing.getPosition(alice.address, MARKET))[0]).to.equal(0n);
    expect((await clearing.getPosition(bob.address, MARKET))[0]).to.equal(0n);

    const margin = (10n * PRICE * INITIAL_BPS) / BPS; // 200
    const pnl = 10n * (newPrice - PRICE); // +100 for long, -100 for short
    const closeNotional = 10n * newPrice; // 1100
    // alice was taker on close, bob maker
    const aliceFee = (closeNotional * TAKER_FEE) / BPS;
    const bobFee = (closeNotional * MAKER_FEE) / BPS;

    expect(await clearing.balanceOf(alice.address)).to.equal(
      aAfterOpen + margin + pnl - aliceFee,
    );
    expect(await clearing.balanceOf(bob.address)).to.equal(
      bAfterOpen + margin - pnl - bobFee,
    );
  });

  it("transfers funding from longs to shorts", async function () {
    const fx = await deployPerpFixture(await hre.network.connect());
    const { clearing, operator, alice, bob, deposit } = fx;

    await deposit(alice, 1000n * M);
    await deposit(bob, 1000n * M);
    // open with zero-fee market would be cleaner, but compute with fees included
    await openLongShort(fx, alice, bob, 10n, PRICE);

    const aAfterOpen = await clearing.balanceOf(alice.address);
    const bAfterOpen = await clearing.balanceOf(bob.address);

    // funding: want long to pay 5 USDR. payment = size*delta/1e18 = 10*delta/1e18 = 5e6
    // => delta = 5e6 * 1e18 / 10 = 5e23
    const delta = (5n * M * 10n ** 18n) / 10n;
    await clearing.connect(operator).pokeFunding(MARKET, delta);

    // close both at flat price -> only funding moves the numbers
    const buy = fx.makeOrder(bob, true, {
      amount: 10n,
      price: PRICE,
      reduceOnly: true,
    });
    const sell = fx.makeOrder(alice, false, {
      amount: 10n,
      price: PRICE,
      reduceOnly: true,
    });
    const buySig = await fx.signOrder(bob, buy);
    const sellSig = await fx.signOrder(alice, sell);
    await clearing
      .connect(operator)
      .settleTrades([fx.trade(buy, buySig, sell, sellSig, 10n, PRICE)]);

    const margin = (10n * PRICE * INITIAL_BPS) / BPS; // 200
    const closeNotional = 10n * PRICE; // 1000
    const aliceFee = (closeNotional * TAKER_FEE) / BPS;
    const bobFee = (closeNotional * MAKER_FEE) / BPS;
    const funding = 5n * M;

    // alice (long) paid funding; bob (short) received it
    expect(await clearing.balanceOf(alice.address)).to.equal(
      aAfterOpen + margin - funding - aliceFee,
    );
    expect(await clearing.balanceOf(bob.address)).to.equal(
      bAfterOpen + margin + funding - bobFee,
    );
    expect(await clearing.fundingPool()).to.equal(0n);
  });

  it("liquidates an under-maintenance position with a penalty", async function () {
    const fx = await deployPerpFixture(await hre.network.connect());
    const { clearing, oracle, admin, operator, alice, bob, deposit } = fx;

    await deposit(alice, 1000n * M);
    await deposit(bob, 1000n * M);
    await openLongShort(fx, alice, bob, 10n, PRICE);

    expect(await clearing.isLiquidatable(alice.address, MARKET)).to.equal(false);

    // drop to 82: equity = 200 - 180 = 20; maintReq = 820*10% = 82 -> liquidatable
    const newPrice = 82n * M;
    await oracle.connect(admin).publishPrice(MARKET, newPrice);
    expect(await clearing.isLiquidatable(alice.address, MARKET)).to.equal(true);

    const aBefore = await clearing.balanceOf(alice.address);
    const feesBefore = await clearing.protocolFees();

    await clearing.connect(operator).liquidate(alice.address, MARKET);

    expect((await clearing.getPosition(alice.address, MARKET))[0]).to.equal(0n);

    const notional = 10n * newPrice; // 820
    const penalty = (notional * LIQ_FEE) / BPS; // 8.2
    const equity = 200n * M - 180n * M; // 20
    const toTrader = equity - penalty;

    expect(await clearing.balanceOf(alice.address)).to.equal(aBefore + toTrader);
    expect(await clearing.protocolFees()).to.equal(feesBefore + penalty);

    // cannot liquidate again (no position)
    await expectCustomError(
      clearing.connect(operator).liquidate(alice.address, MARKET),
      "NoPosition",
    );
  });

  it("covers bad debt from the insurance fund on a gap liquidation", async function () {
    const fx = await deployPerpFixture(await hre.network.connect());
    const { clearing, oracle, admin, operator, insurance, alice, bob, deposit } =
      fx;

    await deposit(alice, 1000n * M);
    await deposit(bob, 1000n * M);
    await openLongShort(fx, alice, bob, 10n, PRICE);

    // gap straight to 70: equity = 200 - 300 = -100 (negative -> insurance covers)
    const newPrice = 70n * M;
    await oracle.connect(admin).publishPrice(MARKET, newPrice);

    const insBefore = await insurance.balance();
    const clearingTokensBefore = await fx.usdr.balanceOf(clearing.target);

    await clearing.connect(operator).liquidate(alice.address, MARKET);

    const deficit = 100n * M;
    expect(await insurance.balance()).to.equal(insBefore - deficit);
    expect(await fx.usdr.balanceOf(clearing.target)).to.equal(
      clearingTokensBefore + deficit,
    );
    expect((await clearing.getPosition(alice.address, MARKET))[0]).to.equal(0n);
  });

  it("enforces non-custodial / authorization invariants", async function () {
    const fx = await deployPerpFixture(await hre.network.connect());
    const { clearing, alice, bob, carol, deposit } = fx;

    await deposit(alice, 1000n * M);
    await deposit(bob, 1000n * M);

    // there is no function letting the operator move a user's free balance:
    // settleTrades requires the SETTLEMENT_ROLE
    const buy = fx.makeOrder(alice, true, { amount: 10n });
    const sell = fx.makeOrder(bob, false, { amount: 10n });
    const buySig = await fx.signOrder(alice, buy);
    const sellSig = await fx.signOrder(bob, sell);
    await expectCustomError(
      clearing
        .connect(carol)
        .settleTrades([fx.trade(buy, buySig, sell, sellSig, 10n, PRICE)]),
      "AccessControlUnauthorizedAccount",
    );

    // bad signature (alice's order signed by carol) is rejected
    const badSig = await fx.signOrder(carol, buy);
    await expectCustomError(
      clearing
        .connect(fx.operator)
        .settleTrades([fx.trade(buy, badSig, sell, sellSig, 10n, PRICE)]),
      "BadSignature",
    );
  });

  it("rejects overfill, reduce-only opens, excess leverage, and cancelled orders", async function () {
    const fx = await deployPerpFixture(await hre.network.connect());
    const { clearing, operator, alice, bob, deposit } = fx;

    await deposit(alice, 1000n * M);
    await deposit(bob, 1000n * M);

    // overfill: order amount 10, try to fill 11
    {
      const buy = fx.makeOrder(alice, true, { amount: 10n });
      const sell = fx.makeOrder(bob, false, { amount: 11n });
      const buySig = await fx.signOrder(alice, buy);
      const sellSig = await fx.signOrder(bob, sell);
      await expectCustomError(
        clearing
          .connect(operator)
          .settleTrades([fx.trade(buy, buySig, sell, sellSig, 11n, PRICE)]),
        "Overfill",
      );
    }

    // reduce-only on a flat account cannot open
    {
      const buy = fx.makeOrder(alice, true, { amount: 10n, reduceOnly: true });
      const sell = fx.makeOrder(bob, false, { amount: 10n });
      const buySig = await fx.signOrder(alice, buy);
      const sellSig = await fx.signOrder(bob, sell);
      await expectCustomError(
        clearing
          .connect(operator)
          .settleTrades([fx.trade(buy, buySig, sell, sellSig, 10n, PRICE)]),
        "ReduceOnlyViolation",
      );
    }

    // marginBps below market minimum (too much leverage) is rejected
    {
      const buy = fx.makeOrder(alice, true, { amount: 10n, marginBps: 1000n });
      const sell = fx.makeOrder(bob, false, { amount: 10n });
      const buySig = await fx.signOrder(alice, buy);
      const sellSig = await fx.signOrder(bob, sell);
      await expectCustomError(
        clearing
          .connect(operator)
          .settleTrades([fx.trade(buy, buySig, sell, sellSig, 10n, PRICE)]),
        "LeverageTooHigh",
      );
    }

    // cancelled order cannot be settled
    {
      const buy = fx.makeOrder(alice, true, { amount: 10n });
      const sell = fx.makeOrder(bob, false, { amount: 10n });
      const buySig = await fx.signOrder(alice, buy);
      const sellSig = await fx.signOrder(bob, sell);
      await clearing.connect(alice).cancelOrder(buy);
      await expectCustomError(
        clearing
          .connect(operator)
          .settleTrades([fx.trade(buy, buySig, sell, sellSig, 10n, PRICE)]),
        "OrderIsCancelled",
      );
    }
  });

  it("guards the oracle against large deviations and stale reads", async function () {
    const fx = await deployPerpFixture(await hre.network.connect());
    const { oracle, admin } = fx;

    // 60% jump exceeds the 50% deviation guard
    await expectCustomError(
      oracle.connect(admin).publishPrice(MARKET, 160n * M),
      "DeviationTooLarge",
    );

    // within guard is fine
    await oracle.connect(admin).publishPrice(MARKET, 140n * M);
    const [price] = await oracle.getPrice(MARKET);
    expect(price).to.equal(140n * M);

    // tighten staleness and roll time forward -> checked read reverts
    await oracle.connect(admin).setMaxStaleness(10n);
    await fx.networkHelpers.time.increase(100);
    await expectCustomError(
      oracle.getPriceChecked(MARKET),
      "StalePrice",
    );
  });
});
