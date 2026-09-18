// Read-only post-deploy assertion of a deployments/<network>.json manifest.
// Proves the suite is wired the way the runbook says before anything real depends on it,
// and re-run after scripts/safe-transfer-admin.js to prove governance actually moved.
//
// Usage:
//   npx hardhat run scripts/verify-deployment.js --network avalanche
//   SAFE_ADDRESS=0x... EXPECT_RENOUNCED=true npx hardhat run scripts/verify-deployment.js --network avalanche
import fs from "node:fs";
import hre from "hardhat";
import {
  DEPLOYER_ROLES,
  OPERATOR_FORBIDDEN_ROLES,
  OPERATOR_HOT_ROLES,
  SAFE_COLD_ROLES,
} from "./lib/roles.js";

const CHAIN_NAMES = { 43113: "fuji", 43114: "avalanche", 31337: "hardhat" };
const DEFAULT_ADMIN = "0x" + "0".repeat(64);

let fails = 0;
let warns = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => {
  fails++;
  console.log(`  FAIL  ${m}`);
};
const warn = (m) => {
  warns++;
  console.log(`  WARN  ${m}`);
};
const check = (cond, m) => (cond ? ok(m) : fail(m));
// Key-segregation checks. On a testnet where deployer == operator == admin by design,
// these can only fail, so they are reported as warnings there and enforced on mainnet.
let checkSep = check;

async function main() {
  const { ethers } = await hre.network.connect();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const networkName = CHAIN_NAMES[chainId] || `chain-${chainId}`;
  const m = JSON.parse(fs.readFileSync(`deployments/${networkName}.json`, "utf8"));
  const c = m.contracts;

  const role = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
  const ac = ["function hasRole(bytes32,address) view returns (bool)"];
  const has = async (addr, r, who) =>
    new ethers.Contract(addr, ac, ethers.provider).hasRole(r === "admin" ? DEFAULT_ADMIN : role(r), who);

  const safe = process.env.SAFE_ADDRESS || m.safe || null;
  const expectRenounced = process.env.EXPECT_RENOUNCED === "true";
  const singleKey = String(m.operator).toLowerCase() === String(m.deployer).toLowerCase();
  if (singleKey && chainId !== 43114) {
    checkSep = (cond, msg) => (cond ? ok(msg) : warn(`${msg} — operator IS the deployer/admin on this deployment`));
  }

  console.log(`\nVerifying ${networkName} (${chainId}) — manifest ${m.deployedAt}`);
  console.log(`  deployer ${m.deployer}\n  operator ${m.operator}\n  safe     ${safe || "(not migrated)"}\n`);

  // --- 1. every address actually holds code ------------------------------
  console.log("Bytecode");
  for (const [name, addr] of Object.entries(c)) {
    check((await ethers.provider.getCode(addr)) !== "0x", `${name} ${addr}`);
  }
  for (const [name, addr] of Object.entries(m.stablecoins || {})) {
    check((await ethers.provider.getCode(addr)) !== "0x", `stablecoin ${name} ${addr}`);
  }

  // --- 2. mainnet must not be running mock stablecoins --------------------
  if (chainId === 43114) {
    console.log("\nMainnet invariants");
    check(m.mockStablecoins === false, "manifest records real (non-mock) stablecoins");
    const erc20 = ["function symbol() view returns (string)", "function decimals() view returns (uint8)"];
    for (const [name, addr] of Object.entries(m.stablecoins || {})) {
      const t = new ethers.Contract(addr, erc20, ethers.provider);
      const sym = await t.symbol();
      const dec = Number(await t.decimals());
      check(dec === 6, `${name} ${sym} is 6dp`);
    }
  }

  // --- 3. wiring ----------------------------------------------------------
  console.log("\nWiring");
  const rbt = new ethers.Contract(
    c.rbt,
    ["function gate() view returns (address)", "function gateExempt(address) view returns (bool)"],
    ethers.provider,
  );
  check((await rbt.gate()).toLowerCase() === c.seriesManager.toLowerCase(), "RBT.gate == SeriesManager");
  check(await rbt.gateExempt(c.spotExchange), "RBT.gateExempt[SpotExchange]");
  check(await has(c.rbt, "WEBLOCK_MANAGER", c.seriesManager), "RBT.MANAGER -> SeriesManager");
  check(await has(c.insuranceFund, "WEBLOCK_DRAWER", c.perpClearing), "InsuranceFund.DRAWER -> PerpClearing");

  // SpotExchange stores the settlement currency as the immutable `quote`.
  const spot = new ethers.Contract(
    c.spotExchange,
    ["function quote() view returns (address)", "function rbt() view returns (address)"],
    ethers.provider,
  );
  check(
    (await spot.quote()).toLowerCase() === String(m.stablecoins.usdc).toLowerCase(),
    "SpotExchange.quote == manifest USDC",
  );
  check((await spot.rbt()).toLowerCase() === c.rbt.toLowerCase(), "SpotExchange.rbt == RBT");

  // --- 4. hot operator roles (keepers must keep working) ------------------
  console.log("\nHot operator roles (must be PRESENT)");
  for (const [k, r] of OPERATOR_HOT_ROLES) {
    check(await has(c[k], r, m.operator), `${k}.${r} held by operator`);
  }

  // --- 5. cold roles the hot key must NOT hold ---------------------------
  console.log("\nHot operator roles (must be ABSENT — SAFE_MIGRATION.md §4b)");
  for (const [k, r] of OPERATOR_FORBIDDEN_ROLES) {
    checkSep(!(await has(c[k], r, m.operator)), `${k}.${r} NOT held by operator`);
  }
  console.log("\nAdmin role (must be ABSENT on the operator)");
  for (const [name, addr] of Object.entries(c)) {
    checkSep(!(await has(addr, "admin", m.operator)), `${name}.DEFAULT_ADMIN_ROLE NOT held by operator`);
  }

  // --- 6. governance ------------------------------------------------------
  if (safe) {
    console.log("\nGovernance (Safe)");
    check((await ethers.provider.getCode(safe)) !== "0x", `Safe ${safe} has code`);
    const safeC = new ethers.Contract(
      safe,
      ["function getOwners() view returns (address[])", "function getThreshold() view returns (uint256)"],
      ethers.provider,
    );
    try {
      const owners = await safeC.getOwners();
      const th = Number(await safeC.getThreshold());
      check(th >= 2, `Safe threshold ${th} of ${owners.length} owners (>= 2)`);
    } catch {
      fail(`${safe} does not answer getOwners()/getThreshold() — not a Safe?`);
    }
    const cold = SAFE_COLD_ROLES;
    for (const [name, addr] of Object.entries(c)) {
      check(await has(addr, "admin", safe), `${name}.DEFAULT_ADMIN_ROLE held by Safe`);
      for (const r of cold[name] || []) {
        check(await has(addr, r, safe), `${name}.${r} held by Safe`);
      }
    }
    if (expectRenounced) {
      console.log("\nDeployer EOA renounced");
      for (const [name, addr] of Object.entries(c)) {
        check(!(await has(addr, "admin", m.deployer)), `${name}.DEFAULT_ADMIN_ROLE renounced by deployer`);
        const leftover = [];
        for (const r of new Set([...(DEPLOYER_ROLES[name] || []), ...(cold[name] || [])])) {
          if (await has(addr, r, m.deployer)) leftover.push(r);
        }
        check(!leftover.length, `${name}: deployer holds no other role${leftover.length ? ` (still: ${leftover.join(", ")})` : ""}`);
      }
    } else {
      console.log("\n  NOTE deployer EOA still holds admin (expected until RENOUNCE_EOA=true).");
    }
  } else {
    console.log("\n  NOTE no Safe recorded — governance is still the deployer EOA.");
  }

  const summary = fails === 0 ? "ALL CHECKS PASSED" : `${fails} CHECK(S) FAILED`;
  console.log(`\n${summary}${warns ? ` — ${warns} warning(s)` : ""}\n`);
  if (fails) process.exitCode = 1;
}

main().catch((e) => {
  console.error("ERR:", e.shortMessage || e.message);
  process.exitCode = 1;
});
