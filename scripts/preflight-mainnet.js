// Read-only mainnet readiness check. Sends no transactions and costs nothing.
// Run this BEFORE scripts/deploy.js --network avalanche and fix every FAIL first.
//
// Usage: npx hardhat run scripts/preflight-mainnet.js --network avalanche
import hre from "hardhat";
import {
  DEFAULT_MIN_DEPLOYER_AVAX,
  DEFAULT_MIN_OPERATOR_AVAX,
  fullSuiteCostWei,
  minDeployerWei,
} from "./lib/gas-budget.js";

const SAFE_INFRA = {
  "SafeL2 1.4.1 singleton": "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
  "SafeProxyFactory 1.4.1": "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
  "FallbackHandler 1.4.1": "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",
  "MultiSendCallOnly 1.4.1": "0x9641d764fc13c8B624c04430C7356C1C7C8102e2",
};

let fails = 0;
let warns = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const warn = (m) => {
  warns++;
  console.log(`  WARN  ${m}`);
};
const fail = (m) => {
  fails++;
  console.log(`  FAIL  ${m}`);
};

async function main() {
  const { ethers } = await hre.network.connect();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log(`\nWeBlock mainnet preflight — chain ${chainId}\n`);
  if (chainId !== 43114) {
    fail(`expected Avalanche C-Chain mainnet (43114), connected to ${chainId}`);
    process.exitCode = 1;
    return;
  }
  ok("connected to Avalanche C-Chain mainnet (43114)");
  const gasPrice = (await ethers.provider.getFeeData()).gasPrice ?? 0n;

  // --- signer -------------------------------------------------------------
  console.log("\nDeployer");
  const signers = await ethers.getSigners();
  if (!signers.length) {
    fail("no signer — set MAINNET_DEPLOYER_PRIVATE_KEY (deliberately separate from DEPLOYER_PRIVATE_KEY)");
  } else {
    const deployer = signers[0];
    const bal = await ethers.provider.getBalance(deployer.address);
    const need = minDeployerWei(
      gasPrice,
      ethers.parseEther(process.env.MIN_DEPLOYER_AVAX || DEFAULT_MIN_DEPLOYER_AVAX),
    );
    const avax = Number(ethers.formatEther(bal));
    const needAvax = Number(ethers.formatEther(need));
    console.log(`        address ${deployer.address}`);
    if (bal >= need) ok(`balance ${avax.toFixed(4)} AVAX (>= ${needAvax.toFixed(4)} needed at this gas price)`);
    else fail(`balance ${avax.toFixed(4)} AVAX — top up to at least ${needAvax.toFixed(4)} AVAX`);
    if ((await ethers.provider.getCode(deployer.address)) !== "0x") {
      fail("deployer address has contract code — it must be an EOA");
    }
  }

  // --- required env -------------------------------------------------------
  console.log("\nEnvironment");
  const required = [
    ["USDC_ADDRESS", "payment + spot quote token"],
    ["USDT_ADDRESS", "secondary payment token"],
    ["FOUNDATION_TREASURY_ADDRESS", "receives the USDR initial supply"],
    ["FEE_TREASURY_ADDRESS", "receives SpotExchange fees"],
    ["BACKEND_OPERATOR_ADDRESS", "hot backend signer (settlement/oracle/KYC)"],
    ["FALLBACK_RBT_URI", "RBT metadata base URI"],
  ];
  for (const [k, why] of required) {
    const v = process.env[k];
    if (!v) {
      fail(`${k} unset — ${why}`);
      continue;
    }
    // Mirror every rejection deploy.js makes, or preflight says READY and the
    // deploy dies on the same value a moment later.
    if (k === "FALLBACK_RBT_URI" && v.includes("weblock/rbt/{id}.json")) {
      fail(`${k} is still the placeholder (${v}) — deploy.js rejects it`);
      continue;
    }
    ok(`${k} = ${v}`);
  }
  if (process.env.DEPLOY_MOCK_STABLES !== "false") {
    fail("DEPLOY_MOCK_STABLES must be explicitly false on mainnet");
  } else ok("DEPLOY_MOCK_STABLES=false");
  if (!process.env.AVALANCHE_RPC_URL) {
    warn("AVALANCHE_RPC_URL unset — using the public rate-limited node; a dropped request mid-deploy leaves a half-wired suite");
  } else ok("AVALANCHE_RPC_URL set (dedicated endpoint)");

  // --- RBT metadata -------------------------------------------------------
  // Every RBT points at this base URI. A host that 404s means every token shows
  // no name and no image in wallets and explorers from the moment it is minted.
  const uriTemplate = process.env.FALLBACK_RBT_URI;
  if (uriTemplate && /^https?:\/\//.test(uriTemplate)) {
    console.log("\nRBT metadata");
    const probe = uriTemplate.replace("{id}", "1");
    try {
      const res = await fetch(probe, { method: "GET", redirect: "follow" });
      if (res.ok) ok(`${probe} -> ${res.status}`);
      else fail(`${probe} -> ${res.status}; every RBT would have broken metadata`);
    } catch (e) {
      fail(`${probe} is unreachable (${e.message})`);
    }
  } else if (uriTemplate) {
    console.log("\nRBT metadata");
    warn(`${uriTemplate} is not http(s) — cannot verify it resolves`);
  }

  // --- external tokens ----------------------------------------------------
  console.log("\nExternal stablecoins");
  const erc20 = [
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function totalSupply() view returns (uint256)",
  ];
  for (const k of ["USDC_ADDRESS", "USDT_ADDRESS"]) {
    const addr = process.env[k];
    if (!addr) continue;
    if (!ethers.isAddress(addr)) {
      fail(`${k} is not an address: ${addr}`);
      continue;
    }
    if ((await ethers.provider.getCode(addr)) === "0x") {
      fail(`${k} ${addr} has no code on mainnet`);
      continue;
    }
    try {
      const t = new ethers.Contract(addr, erc20, ethers.provider);
      const sym = await t.symbol();
      const dec = Number(await t.decimals());
      const supply = await t.totalSupply();
      if (dec !== 6) fail(`${k} ${sym} has ${dec} decimals — the suite assumes 6dp`);
      else ok(`${k} ${addr} = ${sym} (${dec}dp, supply ${(Number(supply) / 1e6).toLocaleString()})`);
    } catch (e) {
      fail(`${k} ${addr} is not a readable ERC-20 (${e.shortMessage || e.message})`);
    }
  }

  // --- operator / treasury sanity -----------------------------------------
  console.log("\nPrincipals");
  const deployerAddr = signers.length ? signers[0].address.toLowerCase() : null;
  for (const k of ["FOUNDATION_TREASURY_ADDRESS", "FEE_TREASURY_ADDRESS", "BACKEND_OPERATOR_ADDRESS"]) {
    const v = process.env[k];
    if (!v || !ethers.isAddress(v)) continue;
    if (v.toLowerCase() === deployerAddr) fail(`${k} must not be the deploy key`);
    else ok(`${k} distinct from the deploy key`);
  }
  const op = process.env.BACKEND_OPERATOR_ADDRESS;
  if (op && ethers.isAddress(op)) {
    const opBalWei = await ethers.provider.getBalance(op);
    const opNeed = ethers.parseEther(process.env.MIN_OPERATOR_AVAX || DEFAULT_MIN_OPERATOR_AVAX);
    const opBal = Number(ethers.formatEther(opBalWei));
    if (opBalWei >= opNeed) ok(`operator holds ${opBal.toFixed(4)} AVAX for gas`);
    else fail(`operator holds ${opBal.toFixed(4)} AVAX — needs ${ethers.formatEther(opNeed)}; keepers (settle/publish/liquidate) will stall`);
  }

  // --- Safe infra ---------------------------------------------------------
  console.log("\nGnosis Safe 1.4.1 infrastructure");
  for (const [label, addr] of Object.entries(SAFE_INFRA)) {
    const code = await ethers.provider.getCode(addr);
    if (code === "0x") fail(`${label} ${addr} missing`);
    else ok(`${label} ${addr}`);
  }
  const safeOwners = (process.env.SAFE_OWNERS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!safeOwners.length) {
    warn("SAFE_OWNERS unset — the governance Safe must exist before RENOUNCE_EOA");
  } else {
    ok(`SAFE_OWNERS lists ${safeOwners.length} owner(s), threshold ${process.env.SAFE_THRESHOLD || "unset"}`);
    for (const o of safeOwners) {
      const b = Number(ethers.formatEther(await ethers.provider.getBalance(o)));
      if (b < 0.05) warn(`Safe owner ${o} holds ${b.toFixed(4)} AVAX — cannot pay to sign`);
    }
  }

  // --- gas estimate -------------------------------------------------------
  console.log("\nGas");
  const gwei = Number(ethers.formatUnits(gasPrice, "gwei"));
  console.log(`        gasPrice ~${gwei.toFixed(4)} gwei`);
  const estAvax = Number(ethers.formatEther(fullSuiteCostWei(gasPrice)));
  console.log(`        full-suite deploy ≈ ${estAvax.toFixed(4)} AVAX at this price`);

  console.log(`\n${fails === 0 ? "READY" : "NOT READY"} — ${fails} fail(s), ${warns} warning(s)\n`);
  if (fails) process.exitCode = 1;
}

main().catch((e) => {
  console.error("ERR:", e.shortMessage || e.message);
  process.exitCode = 1;
});
