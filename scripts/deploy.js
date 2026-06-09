import fs from "node:fs/promises";
import path from "node:path";
import hre from "hardhat";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

async function main() {
  const connection = await hre.network.connect();
  const { ethers } = connection;
  const [deployer] = await ethers.getSigners();
  const networkName =
    process.env.HARDHAT_NETWORK || hre.network.name || "hardhat";

  const admin = process.env.ADMIN_ADDRESS || deployer.address;
  const treasury = process.env.FOUNDATION_TREASURY_ADDRESS || admin;
  const fallbackUri =
    process.env.FALLBACK_RBT_URI || "ipfs://weblock/rbt/{id}.json";
  const deployMockStables =
    (process.env.DEPLOY_MOCK_STABLES || "false").toLowerCase() === "true";

  const WFT = await ethers.getContractFactory("WFTToken");
  const USDR = await ethers.getContractFactory("USDRToken");
  const MockStablecoin = await ethers.getContractFactory("MockStablecoin");
  const Router = await ethers.getContractFactory("RotatingVaultRouter");
  const RBT = await ethers.getContractFactory("RealEstateBackedToken");
  const Manager = await ethers.getContractFactory("RBTSeriesManager");
  const OrderBook = await ethers.getContractFactory("RBTOrderBook");

  let usdtAddress = process.env.USDT_ADDRESS;
  let usdcAddress = process.env.USDC_ADDRESS;

  // Guard against silently overwriting real stablecoins with throwaway mocks
  // (MockStablecoin.mint is unrestricted). If mocks are forced while real
  // addresses are also supplied, that is contradictory — fail loudly instead of
  // wiring the deployment to worthless tokens.
  if (deployMockStables && (usdtAddress || usdcAddress)) {
    throw new Error(
      "DEPLOY_MOCK_STABLES=true but USDT_ADDRESS/USDC_ADDRESS were also provided. " +
        "Refusing to overwrite real stablecoin addresses with mocks. " +
        "Unset the real addresses to use mocks, or unset DEPLOY_MOCK_STABLES.",
    );
  }

  if (deployMockStables || (!usdtAddress && !usdcAddress)) {
    const mockUsdt = await MockStablecoin.deploy("Tether USD", "USDT", 6);
    const mockUsdc = await MockStablecoin.deploy("USD Coin", "USDC", 6);
    await mockUsdt.waitForDeployment();
    await mockUsdc.waitForDeployment();
    usdtAddress = mockUsdt.target;
    usdcAddress = mockUsdc.target;
  }

  if (!usdtAddress || !usdcAddress) {
    requireEnv("USDT_ADDRESS");
    requireEnv("USDC_ADDRESS");
  }

  const wftCap = BigInt(process.env.WFT_CAP || "1000000000000000000000000000");
  const wftInitialTreasuryMint = BigInt(
    process.env.WFT_INITIAL_TREASURY_MINT || "0",
  );
  const usdrInitialSupply = BigInt(process.env.USDR_INITIAL_SUPPLY || "0");

  const wft = await WFT.deploy(admin, treasury, wftCap, wftInitialTreasuryMint);
  const usdr = await USDR.deploy(admin, treasury, usdrInitialSupply);
  const interestRouter = await Router.deploy(admin);
  const redemptionRouter = await Router.deploy(admin);
  const rbt = await RBT.deploy(admin, fallbackUri);
  const manager = await Manager.deploy(
    admin,
    rbt.target,
    interestRouter.target,
    redemptionRouter.target,
  );
  const orderBook = await OrderBook.deploy(admin, rbt.target, manager.target);

  await Promise.all([
    wft.waitForDeployment(),
    usdr.waitForDeployment(),
    interestRouter.waitForDeployment(),
    redemptionRouter.waitForDeployment(),
    rbt.waitForDeployment(),
    manager.waitForDeployment(),
    orderBook.waitForDeployment(),
  ]);

  await (await interestRouter.createVault(usdtAddress, true)).wait();
  await (await interestRouter.createVault(usdcAddress, true)).wait();
  await (await redemptionRouter.createVault(usdtAddress, true)).wait();
  await (await redemptionRouter.createVault(usdcAddress, true)).wait();

  const managerRole = await rbt.MANAGER_ROLE();
  await (await rbt.grantRole(managerRole, manager.target)).wait();
  await (await rbt.setLifecycleManager(manager.target)).wait();

  const treasuryFunderRole = ethers.keccak256(
    ethers.toUtf8Bytes("TREASURY_FUNDER_ROLE"),
  );
  const claimsManagerRole = ethers.keccak256(
    ethers.toUtf8Bytes("CLAIMS_MANAGER_ROLE"),
  );
  await (
    await interestRouter.grantRole(treasuryFunderRole, manager.target)
  ).wait();
  await (
    await interestRouter.grantRole(claimsManagerRole, manager.target)
  ).wait();
  await (
    await redemptionRouter.grantRole(treasuryFunderRole, manager.target)
  ).wait();
  await (
    await redemptionRouter.grantRole(claimsManagerRole, manager.target)
  ).wait();

  // Exempt the order book from the manager's transfer gate so makers can always
  // reclaim escrow (fills remain gated inside the order book itself).
  await (await manager.setTradingVenue(orderBook.target, true)).wait();

  const deployment = {
    network: networkName,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    admin,
    treasury,
    stablecoins: {
      usdt: usdtAddress,
      usdc: usdcAddress,
    },
    contracts: {
      wft: wft.target,
      usdr: usdr.target,
      interestRouter: interestRouter.target,
      redemptionRouter: redemptionRouter.target,
      rbt: rbt.target,
      rbtSeriesManager: manager.target,
      rbtOrderBook: orderBook.target,
    },
  };

  const outputDir = path.join(process.cwd(), "deployments");
  await fs.mkdir(outputDir, { recursive: true });
  const outputFile = path.join(outputDir, `${networkName}.json`);
  await fs.writeFile(outputFile, `${JSON.stringify(deployment, null, 2)}\n`);

  console.log("Deployment completed");
  console.table({
    wft: wft.target,
    usdr: usdr.target,
    usdt: usdtAddress,
    usdc: usdcAddress,
    interestRouter: interestRouter.target,
    redemptionRouter: redemptionRouter.target,
    rbt: rbt.target,
    rbtSeriesManager: manager.target,
    rbtOrderBook: orderBook.target,
  });
  console.log(`Saved deployment manifest to ${outputFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
