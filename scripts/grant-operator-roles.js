// Backfill the backend operator's on-chain roles on an EXISTING deployment.
//
// Why: deploy.js only grants operator roles when BACKEND_OPERATOR_ADDRESS is set and
// distinct from admin at deploy time. The 2026-06-29 Fuji deployment ran without it, so
// the backend operator held none of its operational roles — every gateway write
// (openRound, settle, publish, liquidate, …) reverted with AccessControlUnauthorizedAccount
// until roles were granted ad hoc. This script makes the full intended grant set
// idempotently re-runnable against any deployments/<network>.json manifest.
//
// Usage:
//   BACKEND_OPERATOR_ADDRESS=0x... npx hardhat run scripts/grant-operator-roles.js --network fuji
// The signer must hold DEFAULT_ADMIN_ROLE on each contract (normally the deployer/admin).
import fs from "node:fs";
import hre from "hardhat";

async function main() {
  const { ethers } = await hre.network.connect();
  const [signer] = await ethers.getSigners();
  const networkName = hre.globalOptions?.network || process.env.HARDHAT_NETWORK || "fuji";
  const m = JSON.parse(fs.readFileSync(`deployments/${networkName}.json`, "utf8"));
  const c = m.contracts;

  const operator = process.env.BACKEND_OPERATOR_ADDRESS;
  if (!operator) throw new Error("BACKEND_OPERATOR_ADDRESS is required");

  const role = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
  // Mirrors deploy.js's operator grant block exactly.
  const grants = [
    ["KycRegistry", c.kycRegistry, "WEBLOCK_KYC_MANAGER"],
    ["SeriesManager", c.seriesManager, "WEBLOCK_OPERATOR"],
    ["SeriesManager", c.seriesManager, "WEBLOCK_TREASURY_FUNDER"],
    ["SeriesManager", c.seriesManager, "WEBLOCK_DELINQUENCY_MANAGER"],
    ["IncomeDistributor", c.incomeDistributor, "WEBLOCK_DISTRIBUTION_MANAGER"],
    ["SpotExchange", c.spotExchange, "WEBLOCK_SETTLEMENT"],
    ["NavOracle", c.navOracle, "WEBLOCK_ORACLE_PUBLISHER"],
    ["PerpClearing", c.perpClearing, "WEBLOCK_SETTLEMENT"],
    ["PerpClearing", c.perpClearing, "WEBLOCK_FUNDING"],
    ["PerpClearing", c.perpClearing, "WEBLOCK_LIQUIDATOR"],
    ["PerpClearing", c.perpClearing, "WEBLOCK_MARKET_ADMIN"],
  ];

  const abi = [
    "function hasRole(bytes32,address) view returns (bool)",
    "function grantRole(bytes32,address)",
  ];
  console.log(`signer=${signer.address} operator=${operator} network=${networkName}`);
  let granted = 0;
  for (const [name, addr, r] of grants) {
    const k = new ethers.Contract(addr, abi, signer);
    if (await k.hasRole(role(r), operator)) {
      console.log(`  = ${name}.${r} already held`);
      continue;
    }
    const tx = await k.grantRole(role(r), operator);
    await tx.wait();
    granted++;
    console.log(`  + ${name}.${r} granted (${tx.hash})`);
  }
  console.log(`done — ${granted} new grant(s).`);
}

main().catch((e) => {
  console.error("ERR:", e.shortMessage || e.message);
  process.exit(1);
});
