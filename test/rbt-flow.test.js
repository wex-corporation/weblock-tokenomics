import { expect } from "chai";
import { keccak256, toUtf8Bytes, ZeroAddress } from "ethers";
import hre from "hardhat";

const TREASURY_FUNDER_ROLE = keccak256(toUtf8Bytes("TREASURY_FUNDER_ROLE"));
const CLAIMS_MANAGER_ROLE = keccak256(toUtf8Bytes("CLAIMS_MANAGER_ROLE"));

async function expectCustomError(promise, errorName) {
  try {
    await promise;
    expect.fail(`expected custom error ${errorName}`);
  } catch (error) {
    expect(String(error)).to.contain(errorName);
  }
}

async function deployRbtFixture(connection) {
  const { ethers: connectedEthers, networkHelpers } = connection;
  const [admin, issuerTreasury, alice, bob, carol] =
    await connectedEthers.getSigners();

  const MockStablecoin =
    await connectedEthers.getContractFactory("MockStablecoin");
  const usdt = await MockStablecoin.deploy("Tether USD", "USDT", 6);
  const usdc = await MockStablecoin.deploy("USD Coin", "USDC", 6);

  const Router = await connectedEthers.getContractFactory(
    "RotatingVaultRouter",
  );
  const interestRouter = await Router.deploy(admin.address);
  const redemptionRouter = await Router.deploy(admin.address);

  await interestRouter.createVault(usdt.target, true);
  await interestRouter.createVault(usdc.target, true);
  await redemptionRouter.createVault(usdt.target, true);
  await redemptionRouter.createVault(usdc.target, true);

  const RBT = await connectedEthers.getContractFactory("RealEstateBackedToken");
  const rbt = await RBT.deploy(admin.address, "ipfs://fallback/{id}.json");

  const Manager = await connectedEthers.getContractFactory("RBTSeriesManager");
  const manager = await Manager.deploy(
    admin.address,
    rbt.target,
    interestRouter.target,
    redemptionRouter.target,
  );

  await rbt.grantRole(await rbt.MANAGER_ROLE(), manager.target);
  await rbt.setLifecycleManager(manager.target);

  await interestRouter.grantRole(TREASURY_FUNDER_ROLE, manager.target);
  await interestRouter.grantRole(CLAIMS_MANAGER_ROLE, manager.target);
  await redemptionRouter.grantRole(TREASURY_FUNDER_ROLE, manager.target);
  await redemptionRouter.grantRole(CLAIMS_MANAGER_ROLE, manager.target);

  const OrderBook = await connectedEthers.getContractFactory("RBTOrderBook");
  const orderBook = await OrderBook.deploy(
    admin.address,
    rbt.target,
    manager.target,
  );

  const million = 10n ** 6n;
  const funding = 2_000_000n * million;
  for (const signer of [admin, alice, bob, carol]) {
    await usdt.mint(signer.address, funding);
    await usdc.mint(signer.address, funding);
    await usdt.connect(signer).approve(manager.target, funding);
    await usdc.connect(signer).approve(manager.target, funding);
    await usdt.connect(signer).approve(interestRouter.target, funding);
    await usdc.connect(signer).approve(interestRouter.target, funding);
    await usdt.connect(signer).approve(redemptionRouter.target, funding);
    await usdc.connect(signer).approve(redemptionRouter.target, funding);
    await usdt.connect(signer).approve(orderBook.target, funding);
    await usdc.connect(signer).approve(orderBook.target, funding);
  }

  const now = await networkHelpers.time.latest();
  const saleStart = now + 10;
  const saleEnd = saleStart + 100;
  const maturity = saleEnd + 1000;

  await manager.createSeries(
    {
      tokenId: 1,
      saleStart,
      saleEnd,
      maturityDate: maturity,
      maxSupply: 10,
      issuerTreasury: issuerTreasury.address,
      secondaryTradingEnabled: true,
      propertyCode: "A",
      propertyName: "Asset A",
      roundNumber: 1,
      roundLabel: "A-1",
      metadataURI: "ipfs://asset-a-1.json",
    },
    [usdt.target, usdc.target],
    [100n * million, 100n * million],
  );

  await manager.openSale(1);
  await networkHelpers.time.increaseTo(saleStart + 1);

  return {
    admin,
    issuerTreasury,
    alice,
    bob,
    carol,
    usdt,
    usdc,
    rbt,
    manager,
    orderBook,
    interestRouter,
    redemptionRouter,
    million,
    saleEnd,
    maturity,
  };
}

describe("RBT primary lifecycle", function () {
  it("sells, finalizes, distributes interest across transfers, and redeems", async function () {
    const connection = await hre.network.connect();
    const { networkHelpers } = connection;
    const { alice, bob, issuerTreasury, usdt, rbt, manager, million } =
      await deployRbtFixture(connection);

    await manager
      .connect(alice)
      .buy(1, usdt.target, 6, 600n * million, alice.address);
    await manager
      .connect(bob)
      .buy(1, usdt.target, 4, 400n * million, bob.address);

    expect(await rbt.balanceOf(alice.address, 1)).to.equal(6n);
    expect(await rbt.balanceOf(bob.address, 1)).to.equal(4n);
    expect(await usdt.balanceOf(issuerTreasury.address)).to.equal(
      1000n * million,
    );

    await manager.fundInterest(1, usdt.target, 1000n * million);
    await rbt
      .connect(alice)
      .safeTransferFrom(alice.address, bob.address, 1, 1, "0x");
    await manager.fundInterest(1, usdt.target, 1000n * million);

    const aliceBeforeClaim = await usdt.balanceOf(alice.address);
    const bobBeforeClaim = await usdt.balanceOf(bob.address);

    await manager.connect(alice).claimInterest(1, usdt.target);
    await manager.connect(bob).claimInterest(1, usdt.target);

    expect((await usdt.balanceOf(alice.address)) - aliceBeforeClaim).to.equal(
      1100n * million,
    );
    expect((await usdt.balanceOf(bob.address)) - bobBeforeClaim).to.equal(
      900n * million,
    );

    const latest = await networkHelpers.time.latest();
    await networkHelpers.time.increaseTo(latest + 5000);
    await networkHelpers.mine();
    await manager.enterMaturity(1);
    await manager.enableRedemption(1, usdt.target, 5000n * million);

    const aliceBeforeRedeem = await usdt.balanceOf(alice.address);
    await manager.connect(alice).redeem(1, usdt.target, 5);

    expect(await rbt.balanceOf(alice.address, 1)).to.equal(0n);
    expect((await usdt.balanceOf(alice.address)) - aliceBeforeRedeem).to.equal(
      2500n * million,
    );
  });

  it("does not allow maturity before the configured maturity date unless the series defaulted", async function () {
    const connection = await hre.network.connect();
    const { networkHelpers } = connection;
    const { alice, bob, usdt, manager, million, saleEnd } =
      await deployRbtFixture(connection);

    await manager
      .connect(alice)
      .buy(1, usdt.target, 5, 500n * million, alice.address);
    await manager
      .connect(bob)
      .buy(1, usdt.target, 5, 500n * million, bob.address);

    await expectCustomError(manager.enterMaturity(1), "MaturityNotReached");

    await networkHelpers.time.increaseTo(saleEnd + 50);
    await manager.declareDefault(1, "issuer default");
    await manager.enterMaturity(1);
    expect((await manager.getSeries(1)).state).to.equal(4n);
  });

  it("supports vault rotation without breaking claims on older series", async function () {
    const connection = await hre.network.connect();
    const { alice, bob, admin, usdt, manager, interestRouter, million } =
      await deployRbtFixture(connection);

    await manager
      .connect(alice)
      .buy(1, usdt.target, 5, 500n * million, alice.address);
    await manager
      .connect(bob)
      .buy(1, usdt.target, 5, 500n * million, bob.address);

    await manager.fundInterest(1, usdt.target, 1000n * million);
    const rotatedVaultTx = await interestRouter.createVault(usdt.target, true);
    await rotatedVaultTx.wait();
    await manager.fundInterest(1, usdt.target, 500n * million);

    const aliceBefore = await usdt.balanceOf(alice.address);
    await manager.connect(alice).claimInterest(1, usdt.target);
    expect((await usdt.balanceOf(alice.address)) - aliceBefore).to.equal(
      750n * million,
    );

    const activeVault = await interestRouter.activeVault(usdt.target);
    expect(activeVault).to.not.equal(ZeroAddress);
  });

  it("blocks secondary transfers during delinquency and allows them again after cure", async function () {
    const connection = await hre.network.connect();
    const { alice, bob, usdt, rbt, manager, million } =
      await deployRbtFixture(connection);

    await manager
      .connect(alice)
      .buy(1, usdt.target, 5, 500n * million, alice.address);
    await manager
      .connect(bob)
      .buy(1, usdt.target, 5, 500n * million, bob.address);

    await manager.markDelinquent(1, "late payment notice");
    await expectCustomError(
      rbt
        .connect(alice)
        .safeTransferFrom(alice.address, bob.address, 1, 1, "0x"),
      "TransferNotAllowed",
    );

    await manager.cureDelinquency(1);
    await rbt
      .connect(alice)
      .safeTransferFrom(alice.address, bob.address, 1, 1, "0x");
    expect(await rbt.balanceOf(bob.address, 1)).to.equal(6n);
  });

  it("handles ask and bid orders on the secondary orderbook", async function () {
    const connection = await hre.network.connect();
    const { networkHelpers } = connection;
    const { alice, bob, carol, usdt, rbt, manager, orderBook, million } =
      await deployRbtFixture(connection);

    await manager
      .connect(alice)
      .buy(1, usdt.target, 6, 600n * million, alice.address);
    await manager
      .connect(bob)
      .buy(1, usdt.target, 4, 400n * million, bob.address);

    await rbt.connect(alice).setApprovalForAll(orderBook.target, true);
    await rbt.connect(bob).setApprovalForAll(orderBook.target, true);
    await rbt.connect(carol).setApprovalForAll(orderBook.target, true);

    const current = await networkHelpers.time.latest();
    await orderBook
      .connect(alice)
      .createAsk(1, usdt.target, 2, 120n * million, current + 3600);

    const aliceCashBefore = await usdt.balanceOf(alice.address);
    await orderBook.connect(bob).fillOrder(1, 1, bob.address);
    expect((await usdt.balanceOf(alice.address)) - aliceCashBefore).to.equal(
      120n * million,
    );
    expect(await rbt.balanceOf(bob.address, 1)).to.equal(5n);

    await orderBook.connect(alice).cancelOrder(1);
    expect(await rbt.balanceOf(alice.address, 1)).to.equal(5n);

    await orderBook
      .connect(carol)
      .createBid(1, usdt.target, 2, 130n * million, current + 3600);
    const bobCashBefore = await usdt.balanceOf(bob.address);
    await orderBook.connect(bob).fillOrder(2, 2, alice.address);
    expect((await usdt.balanceOf(bob.address)) - bobCashBefore).to.equal(
      260n * million,
    );
    expect(await rbt.balanceOf(carol.address, 1)).to.equal(2n);
    expect(await rbt.balanceOf(alice.address, 1)).to.equal(5n);
  });

  it("returns refunds when a draft or sale is cancelled", async function () {
    const connection = await hre.network.connect();
    const { alice, usdt, rbt, manager, million } =
      await deployRbtFixture(connection);

    await manager
      .connect(alice)
      .buy(1, usdt.target, 2, 200n * million, alice.address);
    await manager.cancelSale(1, "issuer withdrew the offer");

    const beforeRefund = await usdt.balanceOf(alice.address);
    await manager.connect(alice).claimRefund(1);

    expect((await usdt.balanceOf(alice.address)) - beforeRefund).to.equal(
      200n * million,
    );
    expect(await rbt.balanceOf(alice.address, 1)).to.equal(0n);
  });

  it("rejects series creation with an empty property code or zero supply", async function () {
    const connection = await hre.network.connect();
    const { networkHelpers } = connection;
    const { manager, issuerTreasury, usdt, usdc, million } =
      await deployRbtFixture(connection);

    const now = await networkHelpers.time.latest();
    const params = (overrides) => ({
      tokenId: 2,
      saleStart: now + 10,
      saleEnd: now + 110,
      maturityDate: now + 1110,
      maxSupply: 10,
      issuerTreasury: issuerTreasury.address,
      secondaryTradingEnabled: true,
      propertyCode: "B",
      propertyName: "Asset B",
      roundNumber: 1,
      roundLabel: "B-1",
      metadataURI: "ipfs://b.json",
      ...overrides,
    });
    const tokens = [usdt.target, usdc.target];
    const prices = [100n * million, 100n * million];

    await expectCustomError(
      manager.createSeries(params({ propertyCode: "" }), tokens, prices),
      "InvalidMetadata",
    );
    await expectCustomError(
      manager.createSeries(params({ maxSupply: 0 }), tokens, prices),
      "QuantityTooLow",
    );

    // sanity: a valid series with the same shape still succeeds
    await manager.createSeries(params({}), tokens, prices);
    expect((await manager.getSeries(2)).exists).to.equal(true);
  });

  it("lets a maker reclaim order-book escrow during delinquency while blocking fills", async function () {
    const connection = await hre.network.connect();
    const { alice, bob, usdt, rbt, manager, orderBook, million } =
      await deployRbtFixture(connection);

    // The series manager exempts the order book from its transfer gate so escrow
    // can always be returned; fills are gated inside the order book instead.
    await manager.setTradingVenue(orderBook.target, true);

    await manager
      .connect(alice)
      .buy(1, usdt.target, 6, 600n * million, alice.address);
    await manager
      .connect(bob)
      .buy(1, usdt.target, 4, 400n * million, bob.address);

    await rbt.connect(alice).setApprovalForAll(orderBook.target, true);
    const current = await connection.networkHelpers.time.latest();
    await orderBook
      .connect(alice)
      .createAsk(1, usdt.target, 2, 120n * million, current + 3600);

    // Series becomes delinquent: fills must be blocked...
    await manager.markDelinquent(1, "late payment");
    await expectCustomError(
      orderBook.connect(bob).fillOrder(1, 1, bob.address),
      "TransferNotAllowed",
    );

    // ...but the maker can still cancel and reclaim the escrowed RBT.
    await orderBook.connect(alice).cancelOrder(1);
    expect(await rbt.balanceOf(alice.address, 1)).to.equal(6n);
  });

  it("segregates redemption funds so one series cannot drain another's", async function () {
    const connection = await hre.network.connect();
    const { networkHelpers } = connection;
    const { admin, alice, bob, issuerTreasury, usdt, manager, million } =
      await deployRbtFixture(connection);

    // Series 1: alice fully subscribes, then it matures.
    await manager
      .connect(alice)
      .buy(1, usdt.target, 10, 1000n * million, alice.address);

    // Series 2 shares the same manager + redemption router.
    const now = await networkHelpers.time.latest();
    await manager.createSeries(
      {
        tokenId: 2,
        saleStart: now + 5,
        saleEnd: now + 105,
        maturityDate: now + 1105,
        maxSupply: 10,
        issuerTreasury: issuerTreasury.address,
        secondaryTradingEnabled: true,
        propertyCode: "B",
        propertyName: "Asset B",
        roundNumber: 1,
        roundLabel: "B-1",
        metadataURI: "ipfs://b.json",
      },
      [usdt.target],
      [100n * million],
    );
    await manager.openSale(2);
    await networkHelpers.time.increaseTo(now + 6);
    await manager.connect(bob).buy(2, usdt.target, 10, 1000n * million, bob.address);

    // Mature both and fund EACH series' redemption with its own amount.
    await networkHelpers.time.increaseTo(now + 2000);
    await networkHelpers.mine();
    await manager.enterMaturity(1);
    await manager.enterMaturity(2);
    await manager.enableRedemption(1, usdt.target, 2000n * million);
    await manager.enableRedemption(2, usdt.target, 500n * million);

    expect(await manager.redemptionRemaining(1, usdt.target)).to.equal(
      2000n * million,
    );
    expect(await manager.redemptionRemaining(2, usdt.target)).to.equal(
      500n * million,
    );

    // Series 1 redeems its full entitlement (2000 USDT for 10 units)...
    const aliceBefore = await usdt.balanceOf(alice.address);
    await manager.connect(alice).redeem(1, usdt.target, 10);
    expect((await usdt.balanceOf(alice.address)) - aliceBefore).to.equal(
      2000n * million,
    );
    expect(await manager.redemptionRemaining(1, usdt.target)).to.equal(0n);

    // ...and series 2 can STILL fully redeem its own 500 USDT (not drained).
    const bobBefore = await usdt.balanceOf(bob.address);
    await manager.connect(bob).redeem(2, usdt.target, 10);
    expect((await usdt.balanceOf(bob.address)) - bobBefore).to.equal(
      500n * million,
    );
    expect(await manager.redemptionRemaining(2, usdt.target)).to.equal(0n);
  });
});
