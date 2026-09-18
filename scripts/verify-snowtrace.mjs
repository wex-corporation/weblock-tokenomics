#!/usr/bin/env node
/**
 * Publish the deployed sources on Snowtrace (Routescan), so anyone can read the contracts
 * holding their money instead of taking our word for what is deployed.
 *
 * Two things make this fiddly, and both are handled here rather than by hand:
 *
 *  1. The repo has several build-infos and the suite was not all compiled in one run, so the
 *     standard-json input that matches a given address has to be FOUND, not assumed. Each
 *     contract is matched by comparing compiled deployedBytecode against the code on chain
 *     (immutable slots differ, so those fall back to a length + prefix match).
 *  2. Constructor arguments have to be re-encoded exactly. Addresses and params come from the
 *     deployment manifest; the values that could have drifted (USDR initial supply, RBT base
 *     URI, WFT cap) are read back FROM THE CHAIN instead of from a local .env.
 *
 * Usage:
 *   node scripts/verify-snowtrace.mjs            # dry run: match builds, encode args, print
 *   node scripts/verify-snowtrace.mjs --submit   # submit and poll each verification
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { AbiCoder, Contract, JsonRpcProvider } from "ethers";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const MANIFEST = path.join(ROOT, "deployments", "avalanche.json");
const BUILD_INFO_DIR = path.join(ROOT, "artifacts", "build-info");
const RPC = process.env.AVALANCHE_RPC_URL || "https://api.avax.network/ext/bc/C/rpc";
const API = "https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api";
// Routescan does not issue keys for verification; it accepts this literal.
const API_KEY = process.env.ROUTESCAN_API_KEY || "verifyContract";
const SUBMIT = process.argv.includes("--submit");

const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
const c = m.contracts;
const provider = new JsonRpcProvider(RPC, 43114, { staticNetwork: true });
const coder = AbiCoder.defaultAbiCoder();

/** Every build-info in the repo, newest first, with its compiled output. */
function loadBuilds() {
  const builds = [];
  for (const file of readdirSync(BUILD_INFO_DIR)) {
    if (!file.endsWith(".json") || file.endsWith(".output.json")) continue;
    const input = JSON.parse(readFileSync(path.join(BUILD_INFO_DIR, file), "utf8"));
    const outputPath = path.join(BUILD_INFO_DIR, file.replace(/\.json$/, ".output.json"));
    let output;
    try {
      output = JSON.parse(readFileSync(outputPath, "utf8"));
    } catch {
      continue;
    }
    builds.push({
      file,
      solc: input.solcLongVersion || input.solcVersion,
      input: input.input,
      contracts: output.output?.contracts ?? output.contracts ?? {},
    });
  }
  return builds;
}

/** The build whose compiled code IS the code at `address`. */
function matchBuild(builds, contractName, address, onchain) {
  const candidates = [];
  for (const build of builds) {
    for (const [sourceName, items] of Object.entries(build.contracts)) {
      const artifact = items[contractName];
      if (!artifact) continue;
      const compiled = artifact.evm?.deployedBytecode?.object ?? "";
      if (!compiled) continue;
      const exact = compiled === onchain;
      // Immutables are written at construction, so those bytes differ from the compiled
      // placeholder; same length + same prologue is the strongest signal left.
      const close = compiled.length === onchain.length && compiled.slice(0, 64) === onchain.slice(0, 64);
      if (exact || close) {
        candidates.push({ build, sourceName, artifact, exact });
      }
    }
  }
  candidates.sort((a, b) => Number(b.exact) - Number(a.exact));
  return candidates[0] ?? null;
}

async function constructorArgs() {
  const usdr = new Contract(c.usdr, ["function totalSupply() view returns (uint256)"], provider);
  const rbt = new Contract(c.rbt, ["function uri(uint256) view returns (string)"], provider);
  const wft = new Contract(c.wft, ["function cap() view returns (uint256)"], provider);
  const [usdrSupply, baseUri, wftCap] = await Promise.all([usdr.totalSupply(), rbt.uri(1n), wft.cap()]);
  const admin = m.deployer;
  const p = m.params ?? {};
  return {
    USDR: [["address", "uint256", "address"], [admin, usdrSupply, m.treasury]],
    RBT: [["address", "string"], [admin, baseUri]],
    WFT: [["address", "uint256"], [admin, wftCap]],
    KycRegistry: [["address"], [admin]],
    SeriesManager: [["address", "address", "address"], [admin, c.rbt, c.kycRegistry]],
    IncomeDistributor: [["address"], [admin]],
    SpotExchange: [
      ["address", "address", "address", "address", "address", "uint16"],
      [admin, c.rbt, m.stablecoins.usdc, c.kycRegistry, m.feeTreasury, p.spotFeeBps ?? 100],
    ],
    NavOracle: [["address", "uint256", "uint256"], [admin, p.navMaxDevBps ?? 2000, p.navMaxStale ?? 86400]],
    InsuranceFund: [["address", "address"], [admin, c.usdr]],
    PerpClearing: [["address", "address", "address", "address"], [admin, c.usdr, c.navOracle, c.insuranceFund]],
    WftClaim: [["address", "address"], [admin, c.wft]],
  };
}

const NAME_BY_KEY = {
  usdr: "USDR",
  rbt: "RBT",
  wft: "WFT",
  kycRegistry: "KycRegistry",
  seriesManager: "SeriesManager",
  incomeDistributor: "IncomeDistributor",
  spotExchange: "SpotExchange",
  navOracle: "NavOracle",
  insuranceFund: "InsuranceFund",
  perpClearing: "PerpClearing",
  wftClaim: "WftClaim",
};

async function post(params) {
  const body = new URLSearchParams(params);
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  return res.json();
}

async function alreadyVerified(address) {
  const res = await fetch(
    `${API}?module=contract&action=getsourcecode&address=${address}&apikey=${API_KEY}`,
  );
  const json = await res.json();
  const entry = Array.isArray(json.result) ? json.result[0] : null;
  return Boolean(entry && entry.SourceCode && entry.SourceCode.length > 0);
}

async function waitForResult(guid) {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await fetch(
      `${API}?module=contract&action=checkverifystatus&guid=${guid}&apikey=${API_KEY}`,
    );
    const json = await res.json();
    const message = String(json.result ?? json.message ?? "");
    if (/pending/i.test(message)) continue;
    return message;
  }
  return "timed out waiting for the verifier";
}

async function main() {
  const builds = loadBuilds();
  const args = await constructorArgs();
  console.log(`manifest: chain ${m.chainId}, deployed ${m.deployedAt}`);
  console.log(`builds:   ${builds.length} build-info files`);
  console.log(`mode:     ${SUBMIT ? "SUBMIT" : "dry run (pass --submit to publish)"}\n`);

  let failures = 0;
  for (const [key, address] of Object.entries(c)) {
    const name = NAME_BY_KEY[key];
    if (!name) continue;
    const onchain = (await provider.getCode(address)).slice(2);
    const match = matchBuild(builds, name, address, onchain);
    if (!match) {
      console.log(`  ${name.padEnd(18)} ${address}  NO MATCHING BUILD — skipped`);
      failures++;
      continue;
    }
    const [types, values] = args[name];
    const encoded = coder.encode(types, values).slice(2);
    const fq = `${match.sourceName}:${name}`;
    console.log(
      `  ${name.padEnd(18)} ${address}  ${match.exact ? "exact" : "immutables"}  ${match.build.file.slice(0, 18)}…  args ${encoded.length / 2}B`,
    );

    if (!SUBMIT) continue;

    if (await alreadyVerified(address)) {
      console.log(`      already verified — skipping`);
      continue;
    }
    const submitted = await post({
      apikey: API_KEY,
      module: "contract",
      action: "verifysourcecode",
      contractaddress: address,
      sourceCode: JSON.stringify(match.build.input),
      codeformat: "solidity-standard-json-input",
      contractname: fq,
      compilerversion: `v${match.build.solc}`,
      constructorArguements: encoded,
    });
    if (String(submitted.status) !== "1") {
      console.log(`      submit failed: ${submitted.result ?? submitted.message}`);
      failures++;
      continue;
    }
    const outcome = await waitForResult(submitted.result);
    const ok = /pass|already verified/i.test(outcome);
    console.log(`      ${ok ? "verified" : "FAILED"}: ${outcome}`);
    if (!ok) failures++;
  }

  console.log(
    failures === 0
      ? "\nAll contracts accounted for."
      : `\n${failures} contract(s) need attention.`,
  );
  if (failures) process.exitCode = 1;
}

main().catch((e) => {
  console.error("ERR:", e.shortMessage || e.message);
  process.exitCode = 1;
});
