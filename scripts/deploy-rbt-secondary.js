import fs from "node:fs/promises";
import path from "node:path";
import hre from "hardhat";

// Deploys the RBT secondary-market settlement contracts on top of an existing core
// deployment, reusing its RBT (ERC-1155) and USDC from deployments/<chain>.json:
//   RbtDistributor  : merkle monthly-income claim (backend B1)
//   RbtSpotExchange : EIP-712 atomic RBT<->USDC spot settlement (backend B2)
// Run AFTER scripts/deploy.js. Usage: npx hardhat run scripts/deploy-rbt-secondary.js --network fuji

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

  const manifestPath = path.join(process.cwd(), "deployments", `${networkName}.json`);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

  const admin = manifest.admin || deployer.address;
  const treasury = manifest.treasury || admin;
  const rbt = manifest.contracts?.rbt;
  const usdc = manifest.stablecoins?.usdc;
  if (!rbt) throw new Error("contracts.rbt missing in manifest");
  if (!usdc) throw new Error("stablecoins.usdc missing in manifest");
  const feeBps = Number(process.env.SPOT_FEE_BPS || 100);

  console.log(`Deployer ${deployer.address} on ${networkName} (chainId ${chainId})`);
  console.log(`  rbt=${rbt} usdc=${usdc} admin=${admin} treasury=${treasury} feeBps=${feeBps}`);

  const Dist = await ethers.getContractFactory("RbtDistributor");
  const dist = await Dist.deploy(admin);
  await dist.waitForDeployment();
  console.log("RbtDistributor deployed:", dist.target);

  const Exchange = await ethers.getContractFactory("RbtSpotExchange");
  const exchange = await Exchange.deploy(admin, rbt, usdc, treasury, feeBps);
  await exchange.waitForDeployment();
  console.log("RbtSpotExchange deployed:", exchange.target);

  manifest.contracts = manifest.contracts || {};
  manifest.contracts.rbtDistributor = dist.target;
  manifest.contracts.rbtSpotExchange = exchange.target;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log("Manifest updated:", manifestPath);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
