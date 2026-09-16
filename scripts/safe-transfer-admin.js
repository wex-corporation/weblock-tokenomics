// Transfer WeBlock contract governance (admin authority) to a Gnosis Safe multisig.
//
// The 11 WeBlock contracts use OpenZeppelin AccessControl. DEFAULT_ADMIN_ROLE is the crown
// jewel: whoever holds it can grant/revoke every other role. This script grants the Safe:
//   - DEFAULT_ADMIN_ROLE on every contract  (role management authority)
//   - the "cold" governance roles that must NOT live on the hot backend key:
//       MINTER (USDR, WFT), URI_MANAGER + LOCK_MANAGER (RBT),
//       MARKET_ADMIN (SpotExchange, PerpClearing), PAUSER (PerpClearing),
//       TREASURY_ADMIN (SeriesManager)
// The "hot" operational roles (SETTLEMENT / ORACLE_PUBLISHER / FUNDING / LIQUIDATOR /
// KYC_MANAGER / DISTRIBUTION_MANAGER / TREASURY_FUNDER / DELINQUENCY_MANAGER) stay with the
// backend operator so automated keepers keep working; the Safe can revoke them at will.
//
// Usage:
//   SAFE_ADDRESS=0x... npx hardhat run scripts/safe-transfer-admin.js --network fuji
//   SAFE_ADDRESS=0x... RENOUNCE_EOA=true npx hardhat run scripts/safe-transfer-admin.js --network fuji
//     ^ RENOUNCE_EOA renounces the deployer EOA's admin/cold roles AFTER the Safe is confirmed
//       to hold them. This is IRREVERSIBLE without the Safe — leave it false until the Safe's
//       2-of-N signing has been rehearsed. DRY_RUN=true prints the plan without sending txs.
//
// It also performs the step SAFE_MIGRATION.md §4b calls a hard blocker: revoking the hot
// backend operator's PerpClearing MARKET_ADMIN. That role gates setMaxFillDeviationBps,
// i.e. the oracle safety band on settle() — a single hot key holding it can zero the band
// and settle fills at any signed-limit price. Default ON for mainnet, off elsewhere; set
// REVOKE_OPERATOR_COLD=false/true to override.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import hre from "hardhat";

const R = (name, ethers) => ethers.keccak256(ethers.toUtf8Bytes(name));
const DEFAULT_ADMIN = "0x0000000000000000000000000000000000000000000000000000000000000000";

async function main() {
  const connection = await hre.network.connect();
  const { ethers } = connection;
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const networkName = { 43113: "fuji", 43114: "avalanche", 31337: "hardhat" }[chainId] || `chain-${chainId}`;

  const safe = process.env.SAFE_ADDRESS;
  if (!safe || !ethers.isAddress(safe)) throw new Error("SAFE_ADDRESS env must be a valid address");
  const renounce = process.env.RENOUNCE_EOA === "true";
  const dryRun = process.env.DRY_RUN === "true";
  const isMainnet = chainId === 43114;
  if (isMainnet && process.env.CONFIRM_MAINNET !== "GOVERNANCE") {
    throw new Error("Refusing a mainnet governance change without CONFIRM_MAINNET=GOVERNANCE.");
  }
  const revokeOperatorCold =
    process.env.REVOKE_OPERATOR_COLD !== undefined
      ? process.env.REVOKE_OPERATOR_COLD === "true"
      : isMainnet;

  // The Safe must actually be a Safe: granting DEFAULT_ADMIN_ROLE to a typo'd address
  // and then renouncing would permanently brick governance.
  if ((await ethers.provider.getCode(safe)) === "0x") {
    throw new Error(`SAFE_ADDRESS ${safe} has no code — an EOA/typo cannot govern the suite`);
  }
  {
    const s = new ethers.Contract(
      safe,
      ["function getOwners() view returns (address[])", "function getThreshold() view returns (uint256)"],
      ethers.provider,
    );
    const owners = await s.getOwners();
    const th = Number(await s.getThreshold());
    if (th < 2) throw new Error(`Safe threshold is ${th} — refuse anything below 2`);
    console.log(`  Safe is ${th}-of-${owners.length}: ${owners.join(", ")}`);
  }

  const manifest = JSON.parse(
    readFileSync(path.resolve(`deployments/${networkName}.json`), "utf8")
  );
  const c = manifest.contracts;

  // role bundles per contract: which roles the Safe should hold (beyond DEFAULT_ADMIN everywhere)
  const cold = {
    usdr: ["WEBLOCK_MINTER"],
    wft: ["WEBLOCK_MINTER"],
    rbt: ["WEBLOCK_URI_MANAGER", "WEBLOCK_LOCK_MANAGER"],
    seriesManager: ["WEBLOCK_TREASURY_ADMIN"],
    spotExchange: ["WEBLOCK_MARKET_ADMIN"],
    perpClearing: ["WEBLOCK_MARKET_ADMIN", "WEBLOCK_PAUSER"],
  };

  const acAbi = [
    "function grantRole(bytes32 role, address account)",
    "function revokeRole(bytes32 role, address account)",
    "function renounceRole(bytes32 role, address account)",
    "function hasRole(bytes32 role, address account) view returns (bool)",
  ];

  console.log(`Safe governance migration on ${networkName} (${chainId})`);
  console.log(`  deployer(EOA): ${deployer.address}`);
  console.log(`  Safe(target) : ${safe}`);
  console.log(`  renounceEOA  : ${renounce}   dryRun: ${dryRun}\n`);

  const grants = []; // {name, addr, role, label}
  for (const [name, addr] of Object.entries(c)) {
    grants.push({ name, addr, role: DEFAULT_ADMIN, label: "DEFAULT_ADMIN_ROLE" });
    for (const r of cold[name] || []) grants.push({ name, addr, role: R(r, ethers), label: r });
  }

  // 1) grant to Safe
  for (const g of grants) {
    const ct = new ethers.Contract(g.addr, acAbi, deployer);
    const already = await ct.hasRole(g.role, safe);
    if (already) { console.log(`  = ${g.name}.${g.label} already on Safe`); continue; }
    if (dryRun) { console.log(`  + [dry] grant ${g.name}.${g.label} -> Safe`); continue; }
    const tx = await ct.grantRole(g.role, safe);
    await tx.wait();
    console.log(`  + grant ${g.name}.${g.label} -> Safe   ${tx.hash}`);
  }

  // 2) verify
  console.log("\nVerifying Safe now holds every granted role...");
  let ok = true;
  for (const g of grants) {
    const ct = new ethers.Contract(g.addr, acAbi, deployer);
    const has = await ct.hasRole(g.role, safe);
    if (!has) { ok = false; console.log(`  ! MISSING ${g.name}.${g.label} on Safe`); }
  }
  console.log(ok ? "  all roles confirmed on Safe." : "  SOME ROLES MISSING — do NOT renounce.");

  // 2b) revoke the hot operator's cold roles (SAFE_MIGRATION.md §4b)
  const operator = manifest.operator;
  const operatorIsDeployer =
    !!operator && operator.toLowerCase() === deployer.address.toLowerCase();
  if (operatorIsDeployer && revokeOperatorCold) {
    // On a single-key deployment (Fuji) the "operator" IS the admin. Revoking here would
    // strip the very key that still has to run the renounce step.
    console.log("\nSkipped operator cold-role revoke: operator == deployer on this deployment.");
  } else if (revokeOperatorCold && operator && operator.toLowerCase() !== safe.toLowerCase()) {
    console.log("\nRevoking cold roles from the hot backend operator...");
    const operatorCold = [
      ["perpClearing", c.perpClearing, "WEBLOCK_MARKET_ADMIN"],
      ["perpClearing", c.perpClearing, "WEBLOCK_PAUSER"],
      ["spotExchange", c.spotExchange, "WEBLOCK_MARKET_ADMIN"],
      ["navOracle", c.navOracle, "WEBLOCK_MARKET_ADMIN"],
      ["usdr", c.usdr, "WEBLOCK_MINTER"],
      ["wft", c.wft, "WEBLOCK_MINTER"],
    ];
    for (const [name, addr, r] of operatorCold) {
      if (!addr) continue;
      const ct = new ethers.Contract(addr, acAbi, deployer);
      if (!(await ct.hasRole(R(r, ethers), operator))) {
        console.log(`  = ${name}.${r} not held by operator`);
        continue;
      }
      if (dryRun) {
        console.log(`  - [dry] revoke ${name}.${r} from operator`);
        continue;
      }
      const tx = await ct.revokeRole(R(r, ethers), operator);
      await tx.wait();
      console.log(`  - revoke ${name}.${r} from operator   ${tx.hash}`);
    }
  } else if (!revokeOperatorCold) {
    console.log("\nSkipped operator cold-role revoke (REVOKE_OPERATOR_COLD=false).");
  }

  // 2c) record the Safe in the manifest so verify-deployment.js picks it up
  if (ok && !dryRun && manifest.safe !== safe) {
    manifest.safe = safe;
    writeFileSync(
      path.resolve(`deployments/${networkName}.json`),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    console.log(`\n  manifest updated: deployments/${networkName}.json safe = ${safe}`);
  }

  // 3) optional renounce EOA (guarded)
  if (renounce && ok && !dryRun) {
    console.log("\nRenouncing deployer EOA roles (irreversible without Safe)...");
    for (const g of grants) {
      const ct = new ethers.Contract(g.addr, acAbi, deployer);
      if (!(await ct.hasRole(g.role, deployer.address))) continue;
      const tx = await ct.renounceRole(g.role, deployer.address);
      await tx.wait();
      console.log(`  - renounce ${g.name}.${g.label} from EOA   ${tx.hash}`);
    }
    console.log("  EOA renounced. Governance is now Safe-only.");
  } else if (renounce) {
    console.log("\nSkipped renounce (verification failed or dry-run).");
  } else {
    console.log("\nEOA roles left intact. Rehearse Safe signing, then re-run with RENOUNCE_EOA=true.");
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
