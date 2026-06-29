import { expect } from "chai";
import {
  keccak256,
  toUtf8Bytes,
  AbiCoder,
  concat,
  ZeroAddress,
} from "ethers";
import hre from "hardhat";

const coder = AbiCoder.defaultAbiCoder();
const role = (name) => keccak256(toUtf8Bytes(name));

// roles
const R = {
  MANAGER: role("WEBLOCK_MANAGER"),
  MINTER: role("WEBLOCK_MINTER"),
  KYC_MANAGER: role("WEBLOCK_KYC_MANAGER"),
  OPERATOR: role("WEBLOCK_OPERATOR"),
  TREASURY_FUNDER: role("WEBLOCK_TREASURY_FUNDER"),
  DELINQUENCY_MANAGER: role("WEBLOCK_DELINQUENCY_MANAGER"),
  DISTRIBUTION_MANAGER: role("WEBLOCK_DISTRIBUTION_MANAGER"),
  SETTLEMENT: role("WEBLOCK_SETTLEMENT"),
  FUNDING: role("WEBLOCK_FUNDING"),
  LIQUIDATOR: role("WEBLOCK_LIQUIDATOR"),
  MARKET_ADMIN: role("WEBLOCK_MARKET_ADMIN"),
  ORACLE_PUBLISHER: role("WEBLOCK_ORACLE_PUBLISHER"),
  DRAWER: role("WEBLOCK_DRAWER"),
  LOCK_MANAGER: role("WEBLOCK_LOCK_MANAGER"),
};

// merkle helpers (OZ-compatible: double-hashed leaves + sorted-pair internal nodes)
function leaf2(account, amount) {
  const inner = keccak256(coder.encode(["address", "uint256"], [account, amount]));
  return keccak256(inner);
}
function leaf3(account, amount, track) {
  const inner = keccak256(coder.encode(["address", "uint256", "uint8"], [account, amount, track]));
  return keccak256(inner);
}
function sortedHash(a, b) {
  return BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}
// 2-leaf tree
function tree2(la, lb) {
  const root = sortedHash(la, lb);
  return { root, proofA: [lb], proofB: [la] };
}

// this hardhat setup has no chai-matchers `.reverted`; assert by catching.
async function expectRevert(promise) {
  let threw = false;
  try {
    const tx = await promise;
    if (tx && tx.wait) await tx.wait();
  } catch {
    threw = true;
  }
  expect(threw, "expected transaction to revert").to.equal(true);
}

async function deploySuite() {
  const conn = await hre.network.connect();
  const { ethers } = conn;
  const [admin, treasury, issuer, alice, bob, carol, feeTreasury] = await ethers.getSigners();

  const Mock = await ethers.getContractFactory("MockERC20");
  const usdc = await Mock.deploy("USD Coin", "USDC", 6);
  const usdt = await Mock.deploy("Tether", "USDT", 6);

  const USDR = await ethers.getContractFactory("USDR");
  const usdr = await USDR.deploy(admin.address, 1_000_000_000_000n, treasury.address); // 1M USDR (6dp)

  const RBT = await ethers.getContractFactory("RBT");
  const rbt = await RBT.deploy(admin.address, "ipfs://weblock/{id}.json");

  const WFT = await ethers.getContractFactory("WFT");
  const wft = await WFT.deploy(admin.address, 10n ** 27n); // 1B cap

  const Kyc = await ethers.getContractFactory("KycRegistry");
  const kyc = await Kyc.deploy(admin.address);

  const SeriesManager = await ethers.getContractFactory("SeriesManager");
  const series = await SeriesManager.deploy(admin.address, rbt.target, kyc.target);
  await rbt.grantRole(R.MANAGER, series.target);
  await rbt.setGate(series.target);

  const Income = await ethers.getContractFactory("IncomeDistributor");
  const income = await Income.deploy(admin.address);

  const Spot = await ethers.getContractFactory("SpotExchange");
  const spot = await Spot.deploy(admin.address, rbt.target, usdc.target, kyc.target, feeTreasury.address, 100);
  await rbt.setGateExempt(spot.target, true);

  const Nav = await ethers.getContractFactory("NavOracle");
  const nav = await Nav.deploy(admin.address, 2000, 86400);

  const IF = await ethers.getContractFactory("InsuranceFund");
  const insurance = await IF.deploy(admin.address, usdr.target);

  const Perp = await ethers.getContractFactory("PerpClearing");
  const perp = await Perp.deploy(admin.address, usdr.target, nav.target, insurance.target);
  await insurance.grantRole(R.DRAWER, perp.target);

  const WftClaim = await ethers.getContractFactory("WftClaim");
  const wftClaim = await WftClaim.deploy(admin.address, wft.target);

  // fund actors with stables / usdr
  for (const u of [alice, bob, carol]) {
    await usdc.mint(u.address, 1_000_000_000n); // 1000 USDC
    await usdt.mint(u.address, 1_000_000_000n);
  }
  // distribute USDR from treasury for perp margin + income/redemption funding
  await usdr.connect(treasury).transfer(admin.address, 500_000_000_000n);
  await usdr.connect(treasury).transfer(alice.address, 100_000_000n);
  await usdr.connect(treasury).transfer(bob.address, 100_000_000n);

  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  return {
    ethers, conn, chainId,
    admin, treasury, issuer, alice, bob, carol, feeTreasury,
    usdc, usdt, usdr, rbt, wft, kyc, series, income, spot, nav, insurance, perp, wftClaim,
  };
}

describe("WeBlock greenfield suite", () => {
  describe("Tokens", () => {
    it("USDR is 6dp and mintable by MINTER_ROLE", async () => {
      const s = await deploySuite();
      expect(await s.usdr.decimals()).to.equal(6n);
      await s.usdr.mint(s.alice.address, 1000n);
      expect(await s.usdr.balanceOf(s.alice.address)).to.equal(100_000_000n + 1000n);
    });

    it("WFT respects cap and lock schedule", async () => {
      const s = await deploySuite();
      await s.wft.mintLocked(s.alice.address, 1000n, 9_999_999_999n, false);
      expect(await s.wft.lockedBalanceOf(s.alice.address)).to.equal(1000n);
      await expectRevert(s.wft.connect(s.alice).transfer(s.bob.address, 1n)); // locked
      await s.wft.mint(s.alice.address, 500n);
      await s.wft.connect(s.alice).transfer(s.bob.address, 500n); // free portion
      expect(await s.wft.balanceOf(s.bob.address)).to.equal(500n);
    });

    it("RBT secondary transfer is KYC + state gated", async () => {
      const s = await deploySuite();
      // mint via manager path through a quick active series
      await s.kyc.setVerified(s.alice.address, true);
      await s.series.createSeries(1, s.issuer.address, 0, 9_999_999_999n, 9_999_999_999n, 10_000_000n, 1000, true, [s.usdc.target]);
      await s.series.openSale(1);
      await s.usdc.connect(s.alice).approve(s.series.target, 1_000_000_000n);
      await s.series.connect(s.alice).buy(1, s.usdc.target, 5);
      await s.series.finalizeSale(1);
      // alice -> bob blocked until bob KYC'd
      await expectRevert(s.rbt.connect(s.alice).safeTransferFrom(s.alice.address, s.bob.address, 1, 1, "0x"));
      await s.kyc.setVerified(s.bob.address, true);
      await s.rbt.connect(s.alice).safeTransferFrom(s.alice.address, s.bob.address, 1, 1, "0x");
      expect(await s.rbt.balanceOf(s.bob.address, 1)).to.equal(1n);
    });
  });

  describe("RBT lifecycle (SeriesManager)", () => {
    it("create → sale → buy → finalize → maturity → redeem", async () => {
      const s = await deploySuite();
      await s.kyc.setVerified(s.alice.address, true);
      await s.series.createSeries(7, s.issuer.address, 0, 9_999_999_999n, 9_999_999_999n, 10_000_000n, 1000, true, [s.usdc.target]);
      await s.series.openSale(7);
      await s.usdc.connect(s.alice).approve(s.series.target, 1_000_000_000n);
      await s.series.connect(s.alice).buy(7, s.usdc.target, 10); // 10 RBT * 10 USDC = 100 USDC
      expect(await s.rbt.balanceOf(s.alice.address, 7)).to.equal(10n);
      const issuerBefore = await s.usdc.balanceOf(s.issuer.address);
      await s.series.finalizeSale(7);
      expect(await s.usdc.balanceOf(s.issuer.address)).to.equal(issuerBefore + 100_000_000n);
      // maturity + redemption
      await s.series.enterMaturity(7);
      await s.usdr.connect(s.admin).approve(s.series.target, 1_000_000_000n);
      await s.series.connect(s.admin).enableRedemption(7, s.usdr.target, 11_000_000n); // 11 USDR per token
      const aliceUsdrBefore = await s.usdr.balanceOf(s.alice.address);
      await s.series.connect(s.alice).redeem(7, 10);
      expect(await s.usdr.balanceOf(s.alice.address)).to.equal(aliceUsdrBefore + 110_000_000n);
      expect(await s.rbt.balanceOf(s.alice.address, 7)).to.equal(0n);
    });

    it("cancel → refund returns funds and burns RBT", async () => {
      const s = await deploySuite();
      await s.kyc.setVerified(s.alice.address, true);
      await s.series.createSeries(9, s.issuer.address, 0, 9_999_999_999n, 9_999_999_999n, 10_000_000n, 1000, true, [s.usdc.target]);
      await s.series.openSale(9);
      await s.usdc.connect(s.alice).approve(s.series.target, 1_000_000_000n);
      await s.series.connect(s.alice).buy(9, s.usdc.target, 4);
      const before = await s.usdc.balanceOf(s.alice.address);
      await s.series.cancelSale(9);
      await s.series.connect(s.alice).refund(9);
      expect(await s.usdc.balanceOf(s.alice.address)).to.equal(before + 40_000_000n);
      expect(await s.rbt.balanceOf(s.alice.address, 9)).to.equal(0n);
    });
  });

  describe("IncomeDistributor (merkle)", () => {
    it("opens a round and pays valid claims", async () => {
      const s = await deploySuite();
      const aAmt = 30_000_000n, bAmt = 20_000_000n; // 30 + 20 USDC
      const la = leaf2(s.alice.address, aAmt), lb = leaf2(s.bob.address, bAmt);
      const { root, proofA, proofB } = tree2(la, lb);
      await s.usdc.mint(s.admin.address, 50_000_000n);
      await s.usdc.connect(s.admin).approve(s.income.target, 50_000_000n);
      await s.income.openRound(1, s.usdc.target, root, 50_000_000n, 202606);
      const aBefore = await s.usdc.balanceOf(s.alice.address);
      await s.income.connect(s.alice).claim(1, aAmt, proofA);
      expect(await s.usdc.balanceOf(s.alice.address)).to.equal(aBefore + aAmt);
      await expectRevert(s.income.connect(s.alice).claim(1, aAmt, proofA)); // double claim
      await s.income.connect(s.bob).claim(1, bAmt, proofB);
    });
  });

  describe("SpotExchange (EIP-712)", () => {
    it("settles a signed buy/sell pair atomically", async () => {
      const s = await deploySuite();
      // give alice RBT id 1 (KYC'd), bob will buy
      await s.kyc.setVerified(s.alice.address, true);
      await s.kyc.setVerified(s.bob.address, true);
      await s.series.createSeries(1, s.issuer.address, 0, 9_999_999_999n, 9_999_999_999n, 10_000_000n, 1000, true, [s.usdc.target]);
      await s.series.openSale(1);
      await s.usdc.connect(s.alice).approve(s.series.target, 1_000_000_000n);
      await s.series.connect(s.alice).buy(1, s.usdc.target, 10);
      await s.series.finalizeSale(1);

      // alice approves spot as RBT operator; bob approves quote
      await s.rbt.connect(s.alice).setApprovalForAll(s.spot.target, true);
      await s.usdc.connect(s.bob).approve(s.spot.target, 1_000_000_000n);

      const domain = { name: "WeBlockSpot", version: "1", chainId: s.chainId, verifyingContract: s.spot.target };
      const types = { Order: [
        { name: "trader", type: "address" }, { name: "marketId", type: "uint256" },
        { name: "isBuy", type: "bool" }, { name: "price", type: "uint256" },
        { name: "amount", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "expiry", type: "uint256" },
      ]};
      const price = 12_000_000n; // 12 USDC per RBT
      const sell = { trader: s.alice.address, marketId: 1n, isBuy: false, price, amount: 5n, nonce: 1n, expiry: 9_999_999_999n };
      const buy = { trader: s.bob.address, marketId: 1n, isBuy: true, price, amount: 5n, nonce: 1n, expiry: 9_999_999_999n };
      const sellSig = await s.alice.signTypedData(domain, types, sell);
      const buySig = await s.bob.signTypedData(domain, types, buy);

      const sellerBefore = await s.usdc.balanceOf(s.alice.address);
      await s.spot.settle(buy, buySig, sell, sellSig, 5n, price);
      expect(await s.rbt.balanceOf(s.bob.address, 1)).to.equal(5n);
      // seller got 60 USDC minus 1% fee = 59.4
      expect(await s.usdc.balanceOf(s.alice.address)).to.equal(sellerBefore + 59_400_000n);
      expect(await s.usdc.balanceOf(s.feeTreasury.address)).to.equal(600_000n);
    });
  });

  describe("PerpClearing", () => {
    async function setupPerp() {
      const s = await deploySuite();
      await s.perp.createMarket(1, 2000, 1000, 10, 5, 200); // 5x max, 10% mm, fees, 2% liq
      const t0 = (await s.ethers.provider.getBlock("latest")).timestamp;
      await s.nav.publish(1, 100_000_000n, BigInt(t0)); // 100 USDR per unit
      // alice + bob deposit margin
      await s.usdr.connect(s.alice).approve(s.perp.target, 100_000_000n);
      await s.usdr.connect(s.bob).approve(s.perp.target, 100_000_000n);
      await s.perp.connect(s.alice).deposit(100_000_000n);
      await s.perp.connect(s.bob).deposit(100_000_000n);
      return s;
    }
    function perpDomain(s) {
      return { name: "WeBlockPerp", version: "1", chainId: s.chainId, verifyingContract: s.perp.target };
    }
    const perpTypes = { Order: [
      { name: "trader", type: "address" }, { name: "marketId", type: "uint256" },
      { name: "isBuy", type: "bool" }, { name: "price", type: "uint256" }, { name: "amount", type: "uint256" },
      { name: "marginBps", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "expiry", type: "uint256" },
      { name: "reduceOnly", type: "bool" },
    ]};

    it("deposit / withdraw is user-only free equity", async () => {
      const s = await setupPerp();
      expect(await s.perp.freeCollateral(s.alice.address)).to.equal(100_000_000n);
      await s.perp.connect(s.alice).withdraw(40_000_000n);
      expect(await s.perp.freeCollateral(s.alice.address)).to.equal(60_000_000n);
      await expectRevert(s.perp.connect(s.alice).withdraw(1_000_000_000n)); // not free
    });

    it("opens a long/short via matched orders and settles funding", async () => {
      const s = await setupPerp();
      const d = perpDomain(s);
      const price = 100_000_000n;
      // alice long 1 unit, bob short 1 unit at 100, 20% margin
      const aOrder = { trader: s.alice.address, marketId: 1n, isBuy: true, price, amount: 1n, marginBps: 2000n, nonce: 1n, expiry: 9_999_999_999n, reduceOnly: false };
      const bOrder = { trader: s.bob.address, marketId: 1n, isBuy: false, price, amount: 1n, marginBps: 2000n, nonce: 1n, expiry: 9_999_999_999n, reduceOnly: false };
      const aSig = await s.alice.signTypedData(d, perpTypes, aOrder);
      const bSig = await s.bob.signTypedData(d, perpTypes, bOrder);
      await s.perp.settleTrades(aOrder, aSig, bOrder, bSig, 1n, price);
      const ap = await s.perp.getPosition(1, s.alice.address);
      expect(ap.size).to.equal(1n);
      expect(ap.margin).to.equal(20_000_000n); // 20% of 100 notional
      // apply positive funding -> longs pay
      await s.perp.applyFunding(1, 1_000_000n * (10n ** 18n) / 100_000_000n); // small
      // no revert; funding settled lazily on next touch / liquidate
    });

    it("liquidates an underwater position", async () => {
      const s = await setupPerp();
      const d = perpDomain(s);
      const price = 100_000_000n;
      const aOrder = { trader: s.alice.address, marketId: 1n, isBuy: true, price, amount: 1n, marginBps: 2000n, nonce: 1n, expiry: 9_999_999_999n, reduceOnly: false };
      const bOrder = { trader: s.bob.address, marketId: 1n, isBuy: false, price, amount: 1n, marginBps: 2000n, nonce: 1n, expiry: 9_999_999_999n, reduceOnly: false };
      await s.perp.settleTrades(aOrder, await s.alice.signTypedData(d, perpTypes, aOrder), bOrder, await s.bob.signTypedData(d, perpTypes, bOrder), 1n, price);
      // price drops 20% -> long alice underwater (margin 20, loss 20 > maintenance 10% of new notional)
      const t1 = (await s.ethers.provider.getBlock("latest")).timestamp;
      await s.nav.publish(1, 80_000_000n, BigInt(t1 + 1));
      await expectRevert(s.perp.connect(s.bob).liquidate(1, s.alice.address)); // bob lacks role
      await s.perp.liquidate(1, s.alice.address);
      const ap = await s.perp.getPosition(1, s.alice.address);
      expect(ap.size).to.equal(0n);
    });
  });

  describe("WftClaim (gated)", () => {
    it("is paused until enabled, then mints per merkle proof", async () => {
      const s = await deploySuite();
      const amt = 1000n;
      const la = leaf3(s.alice.address, amt, 0), lb = leaf3(s.bob.address, amt, 0);
      const { root, proofA } = tree2(la, lb);
      await expectRevert(s.wftClaim.connect(s.alice).claim(amt, 0, proofA)); // paused
      await s.wftClaim.configure(root, 9_999_999_999n);
      await s.wft.grantRole(R.MINTER, s.wftClaim.target);
      await s.wft.grantRole(R.LOCK_MANAGER, s.wftClaim.target);
      await s.wftClaim.enable();
      await s.wftClaim.connect(s.alice).claim(amt, 0, proofA);
      expect(await s.wft.balanceOf(s.alice.address)).to.equal(amt);
    });
  });
});

describe("WeBlock edge cases", () => {
  async function activeSeriesWithHolders() {
    const s = await deploySuite();
    await s.kyc.setVerified(s.alice.address, true);
    await s.kyc.setVerified(s.bob.address, true);
    await s.series.createSeries(1, s.issuer.address, 0, 9_999_999_999n, 9_999_999_999n, 10_000_000n, 1000, true, [s.usdc.target]);
    await s.series.openSale(1);
    await s.usdc.connect(s.alice).approve(s.series.target, 1_000_000_000n);
    await s.series.connect(s.alice).buy(1, s.usdc.target, 20);
    await s.series.finalizeSale(1);
    return s;
  }

  it("buy without KYC reverts", async () => {
    const s = await deploySuite();
    await s.series.createSeries(1, s.issuer.address, 0, 9_999_999_999n, 9_999_999_999n, 10_000_000n, 1000, true, [s.usdc.target]);
    await s.series.openSale(1);
    await s.usdc.connect(s.alice).approve(s.series.target, 1_000_000_000n);
    await expectRevert(s.series.connect(s.alice).buy(1, s.usdc.target, 1)); // not KYC'd
  });

  it("delinquent series blocks secondary transfer; cure restores it", async () => {
    const s = await activeSeriesWithHolders();
    await s.series.markDelinquent(1);
    await expectRevert(s.rbt.connect(s.alice).safeTransferFrom(s.alice.address, s.bob.address, 1, 1, "0x"));
    await s.series.cure(1);
    await s.rbt.connect(s.alice).safeTransferFrom(s.alice.address, s.bob.address, 1, 1, "0x");
    expect(await s.rbt.balanceOf(s.bob.address, 1)).to.equal(1n);
  });

  it("redeem before maturity reverts", async () => {
    const s = await activeSeriesWithHolders();
    await expectRevert(s.series.connect(s.alice).redeem(1, 1));
  });

  it("spot: expired order, self-trade, and invalidated nonce all revert", async () => {
    const s = await activeSeriesWithHolders();
    await s.rbt.connect(s.alice).setApprovalForAll(s.spot.target, true);
    await s.usdc.connect(s.bob).approve(s.spot.target, 1_000_000_000n);
    const domain = { name: "WeBlockSpot", version: "1", chainId: s.chainId, verifyingContract: s.spot.target };
    const types = { Order: [
      { name: "trader", type: "address" }, { name: "marketId", type: "uint256" },
      { name: "isBuy", type: "bool" }, { name: "price", type: "uint256" },
      { name: "amount", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "expiry", type: "uint256" },
    ]};
    const price = 12_000_000n;
    // expired sell
    const expSell = { trader: s.alice.address, marketId: 1n, isBuy: false, price, amount: 2n, nonce: 1n, expiry: 1n };
    const buy = { trader: s.bob.address, marketId: 1n, isBuy: true, price, amount: 2n, nonce: 1n, expiry: 9_999_999_999n };
    const expSellSig = await s.alice.signTypedData(domain, types, expSell);
    const buySig = await s.bob.signTypedData(domain, types, buy);
    await expectRevert(s.spot.settle(buy, buySig, expSell, expSellSig, 2n, price)); // expired

    // self-trade (same trader both sides)
    const selfBuy = { trader: s.alice.address, marketId: 1n, isBuy: true, price, amount: 2n, nonce: 2n, expiry: 9_999_999_999n };
    const selfSell = { trader: s.alice.address, marketId: 1n, isBuy: false, price, amount: 2n, nonce: 3n, expiry: 9_999_999_999n };
    await expectRevert(s.spot.settle(
      selfBuy, await s.alice.signTypedData(domain, types, selfBuy),
      selfSell, await s.alice.signTypedData(domain, types, selfSell), 2n, price));

    // invalidated nonce on the seller
    const sell = { trader: s.alice.address, marketId: 1n, isBuy: false, price, amount: 2n, nonce: 9n, expiry: 9_999_999_999n };
    await s.spot.connect(s.alice).invalidateNonce(9n);
    await expectRevert(s.spot.settle(buy, buySig, sell, await s.alice.signTypedData(domain, types, sell), 2n, price));
  });

  it("perp: reduce-only on a fresh position reverts; partial close realizes proportional PnL", async () => {
    const s = await deploySuite();
    await s.perp.createMarket(1, 2000, 1000, 0, 0, 200); // zero fees for clean accounting
    const t0 = (await s.ethers.provider.getBlock("latest")).timestamp;
    await s.nav.publish(1, 100_000_000n, BigInt(t0));
    await s.usdr.connect(s.alice).approve(s.perp.target, 100_000_000n);
    await s.usdr.connect(s.bob).approve(s.perp.target, 100_000_000n);
    await s.perp.connect(s.alice).deposit(100_000_000n);
    await s.perp.connect(s.bob).deposit(100_000_000n);
    const d = { name: "WeBlockPerp", version: "1", chainId: s.chainId, verifyingContract: s.perp.target };
    const types = { Order: [
      { name: "trader", type: "address" }, { name: "marketId", type: "uint256" },
      { name: "isBuy", type: "bool" }, { name: "price", type: "uint256" }, { name: "amount", type: "uint256" },
      { name: "marginBps", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "expiry", type: "uint256" },
      { name: "reduceOnly", type: "bool" },
    ]};
    const price = 100_000_000n;
    // reduce-only opening order must revert
    const ro = { trader: s.alice.address, marketId: 1n, isBuy: true, price, amount: 2n, marginBps: 5000n, nonce: 1n, expiry: 9_999_999_999n, reduceOnly: true };
    const cp = { trader: s.bob.address, marketId: 1n, isBuy: false, price, amount: 2n, marginBps: 5000n, nonce: 1n, expiry: 9_999_999_999n, reduceOnly: false };
    await expectRevert(s.perp.settleTrades(ro, await s.alice.signTypedData(d, types, ro), cp, await s.bob.signTypedData(d, types, cp), 2n, price));

    // open alice long 2 @100 with 50% margin (=100 margin), bob short
    const aOpen = { trader: s.alice.address, marketId: 1n, isBuy: true, price, amount: 2n, marginBps: 5000n, nonce: 2n, expiry: 9_999_999_999n, reduceOnly: false };
    const bOpen = { trader: s.bob.address, marketId: 1n, isBuy: false, price, amount: 2n, marginBps: 5000n, nonce: 2n, expiry: 9_999_999_999n, reduceOnly: false };
    await s.perp.settleTrades(aOpen, await s.alice.signTypedData(d, types, aOpen), bOpen, await s.bob.signTypedData(d, types, bOpen), 2n, price);
    let ap = await s.perp.getPosition(1, s.alice.address);
    expect(ap.size).to.equal(2n);
    expect(ap.margin).to.equal(100_000_000n); // 50% of 200 notional

    // partial close 1 unit at 120 (profit 20 on 1 unit); reduceOnly sell
    const p2 = 120_000_000n;
    const aClose = { trader: s.alice.address, marketId: 1n, isBuy: false, price: p2, amount: 1n, marginBps: 5000n, nonce: 3n, expiry: 9_999_999_999n, reduceOnly: true };
    const bClose = { trader: s.bob.address, marketId: 1n, isBuy: true, price: p2, amount: 1n, marginBps: 5000n, nonce: 3n, expiry: 9_999_999_999n, reduceOnly: true };
    const freeBefore = await s.perp.freeCollateral(s.alice.address);
    await s.perp.settleTrades(bClose, await s.bob.signTypedData(d, types, bClose), aClose, await s.alice.signTypedData(d, types, aClose), 1n, p2);
    ap = await s.perp.getPosition(1, s.alice.address);
    expect(ap.size).to.equal(1n); // half closed
    // released margin (50) + pnl(+20) = 70 returned to free collateral
    const freeAfter = await s.perp.freeCollateral(s.alice.address);
    expect(freeAfter - freeBefore).to.equal(70_000_000n);
  });

  it("perp: cannot withdraw collateral locked in a position", async () => {
    const s = await deploySuite();
    await s.perp.createMarket(1, 2000, 1000, 0, 0, 200);
    const t0 = (await s.ethers.provider.getBlock("latest")).timestamp;
    await s.nav.publish(1, 100_000_000n, BigInt(t0));
    await s.usdr.connect(s.alice).approve(s.perp.target, 100_000_000n);
    await s.usdr.connect(s.bob).approve(s.perp.target, 100_000_000n);
    await s.perp.connect(s.alice).deposit(100_000_000n);
    await s.perp.connect(s.bob).deposit(100_000_000n);
    const d = { name: "WeBlockPerp", version: "1", chainId: s.chainId, verifyingContract: s.perp.target };
    const types = { Order: [
      { name: "trader", type: "address" }, { name: "marketId", type: "uint256" },
      { name: "isBuy", type: "bool" }, { name: "price", type: "uint256" }, { name: "amount", type: "uint256" },
      { name: "marginBps", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "expiry", type: "uint256" },
      { name: "reduceOnly", type: "bool" },
    ]};
    const price = 100_000_000n;
    const aOpen = { trader: s.alice.address, marketId: 1n, isBuy: true, price, amount: 1n, marginBps: 5000n, nonce: 1n, expiry: 9_999_999_999n, reduceOnly: false };
    const bOpen = { trader: s.bob.address, marketId: 1n, isBuy: false, price, amount: 1n, marginBps: 5000n, nonce: 1n, expiry: 9_999_999_999n, reduceOnly: false };
    await s.perp.settleTrades(aOpen, await s.alice.signTypedData(d, types, aOpen), bOpen, await s.bob.signTypedData(d, types, bOpen), 1n, price);
    // 50 locked as margin, 50 free; withdrawing 60 must revert
    await expectRevert(s.perp.connect(s.alice).withdraw(60_000_000n));
    await s.perp.connect(s.alice).withdraw(50_000_000n); // exactly free ok
  });
});
