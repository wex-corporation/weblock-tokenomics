import fs from "node:fs/promises";
import path from "node:path";
import hre from "hardhat";

// Deploys the RBT perpetual-futures stack (NavOracle + InsuranceFund +
// PerpClearing) on top of an existing core deployment, reusing its USDR token as
// the quote/collateral asset. Run AFTER scripts/deploy.js so the core manifest
// exists.
//
//   USDR collateral  : taken from deployments/<chain>.json -> contracts.usdr
//   settlement op     : PERP_OPERATOR_ADDRESS (the backend matching/settlement key)
//   nav publisher     : NAV_PUBLISHER_ADDRESS (the backend NAV oracle key)
//   deviation guard   : PERP_MAX_DEVIATION_BPS (default 2000 = 20%)
//   staleness window  : PERP_MAX_STALENESS_SECS (default 3600)

const CHAIN_NAMES = {
  43113: "fuji",
  43114: "avalanche",
  43110: "avalancheSubnet",
  11155111: "sepolia",
  84532: "baseSepolia",
  97: "bnbTestnet",
  195: "xlayerTestnet",
  31337: "hardhat",
};

async function main() {
  const connection = await hre.network.connect();
  const { ethers } = connection;
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const networkName =
    process.env.HARDHAT_NETWORK || CHAIN_NAMES[chainId] || `chain-${chainId}`;

  const manifestPath = path.join(
    process.cwd(),
    "deployments",
    `${networkName}.json`,
  );
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch {
    throw new Error(
      `Core deployment manifest not found at ${manifestPath}. Run scripts/deploy.js first.`,
    );
  }

  const quoteToken = manifest.contracts?.usdr;
  if (!quoteToken) {
    throw new Error("Manifest has no contracts.usdr (quote/collateral token).");
  }

  const admin = process.env.ADMIN_ADDRESS || manifest.admin || deployer.address;
  const settlementOperator = process.env.PERP_OPERATOR_ADDRESS || admin;
  const navPublisher = process.env.NAV_PUBLISHER_ADDRESS || admin;
  const maxDeviationBps = BigInt(process.env.PERP_MAX_DEVIATION_BPS || "2000");
  const maxStaleness = BigInt(process.env.PERP_MAX_STALENESS_SECS || "3600");

  console.log(`Deploying perp stack on ${networkName} (chainId ${chainId})`);
  console.log(`  quote token (USDR): ${quoteToken}`);
  console.log(`  admin:              ${admin}`);
  console.log(`  settlement op:      ${settlementOperator}`);
  console.log(`  nav publisher:      ${navPublisher}`);

  const NavOracle = await ethers.getContractFactory("NavOracle");
  const oracle = await NavOracle.deploy(
    admin,
    navPublisher,
    maxDeviationBps,
    maxStaleness,
  );
  await oracle.waitForDeployment();

  const InsuranceFund = await ethers.getContractFactory("InsuranceFund");
  const insurance = await InsuranceFund.deploy(admin, quoteToken);
  await insurance.waitForDeployment();

  const PerpClearing = await ethers.getContractFactory("PerpClearing");
  const clearing = await PerpClearing.deploy(
    admin,
    quoteToken,
    oracle.target,
    insurance.target,
    settlementOperator,
  );
  await clearing.waitForDeployment();

  // Allow the clearing house to draw from the insurance fund to cover bad debt.
  const drawerRole = await insurance.DRAWER_ROLE();
  await (await insurance.grantRole(drawerRole, clearing.target)).wait();

  manifest.perp = {
    deployedAt: new Date().toISOString(),
    settlementOperator,
    navPublisher,
    maxDeviationBps: Number(maxDeviationBps),
    maxStalenessSecs: Number(maxStaleness),
    contracts: {
      navOracle: oracle.target,
      insuranceFund: insurance.target,
      perpClearing: clearing.target,
    },
  };

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log("Perp deployment completed");
  console.table({
    navOracle: oracle.target,
    insuranceFund: insurance.target,
    perpClearing: clearing.target,
  });
  console.log(`Updated manifest at ${manifestPath}`);
  console.log(
    "Next: fund the insurance fund, initialise oracle market(s), and addMarket() on PerpClearing.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
