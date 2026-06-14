import fs from "node:fs/promises";
import path from "node:path";
import hre from "hardhat";

// Grants the backend signing keys the roles needed to operate the perp market:
//   PERP_OPERATOR_ADDRESS      -> SETTLEMENT_ROLE, FUNDING_ROLE, LIQUIDATOR_ROLE on PerpClearing
//   PERP_NAV_PUBLISHER_ADDRESS -> ORACLE_PUBLISHER_ROLE on NavOracle
// Run by the admin (DEFAULT_ADMIN_ROLE = deployer). Idempotent (skips roles already held).
//
//   PERP_OPERATOR_ADDRESS=0x... PERP_NAV_PUBLISHER_ADDRESS=0x... \
//     npx hardhat run scripts/perp-grant-roles.js --network fuji

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
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const networkName =
    process.env.HARDHAT_NETWORK || CHAIN_NAMES[chainId] || `chain-${chainId}`;

  const manifest = JSON.parse(
    await fs.readFile(
      path.join(process.cwd(), "deployments", `${networkName}.json`),
      "utf8",
    ),
  );
  const perp = manifest.perp?.contracts;
  if (!perp?.perpClearing || !perp?.navOracle) {
    throw new Error("No perp deployment in manifest. Run deploy-perp.js first.");
  }

  const operator = process.env.PERP_OPERATOR_ADDRESS;
  const navPublisher = process.env.PERP_NAV_PUBLISHER_ADDRESS || operator;
  if (!operator) {
    throw new Error("PERP_OPERATOR_ADDRESS is required (the backend signing key address).");
  }

  const clearing = await ethers.getContractAt("PerpClearing", perp.perpClearing);
  const oracle = await ethers.getContractAt("NavOracle", perp.navOracle);

  const grant = async (contract, roleName, role, account) => {
    if (await contract.hasRole(role, account)) {
      console.log(`  ${roleName} already held by ${account}, skipping`);
      return;
    }
    await (await contract.grantRole(role, account)).wait();
    console.log(`  granted ${roleName} to ${account}`);
  };

  console.log(`Granting perp roles on ${networkName}`);
  await grant(clearing, "SETTLEMENT_ROLE", await clearing.SETTLEMENT_ROLE(), operator);
  await grant(clearing, "FUNDING_ROLE", await clearing.FUNDING_ROLE(), operator);
  await grant(clearing, "LIQUIDATOR_ROLE", await clearing.LIQUIDATOR_ROLE(), operator);
  await grant(
    oracle,
    "ORACLE_PUBLISHER_ROLE",
    await oracle.ORACLE_PUBLISHER_ROLE(),
    navPublisher,
  );
  console.log("Done.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
