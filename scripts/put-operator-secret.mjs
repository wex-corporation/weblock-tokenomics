#!/usr/bin/env node
/**
 * Move the mainnet backend operator key from the local file into the AWS Secrets
 * Manager secret the API reads (`weblock-api`), without ever printing it.
 *
 * Why a script: the API resolves the mainnet signer as
 *   APP_BLOCKCHAIN_AVALANCHE_OPERATOR_PRIVATE_KEY -> APP_BLOCKCHAIN_OPERATOR_PRIVATE_KEY
 * so a MISSING mainnet key silently falls back to the Fuji key, whose address holds
 * none of the mainnet roles. Every keeper call would then revert on chain. This
 * checks the key actually derives the operator address in the deployment manifest
 * before writing, and refuses otherwise.
 *
 * Usage (from weblock-token):
 *   node scripts/put-operator-secret.mjs            # dry run: verify only
 *   node scripts/put-operator-secret.mjs --write    # patch the secret
 *
 * Existing entries in the secret are preserved; only the one key is added/replaced.
 * After a successful --write, delete .env.mainnet.operator-key.
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { Wallet } from "ethers";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const KEY_FILE = path.join(ROOT, ".env.mainnet.operator-key");
const MANIFEST = path.join(ROOT, "deployments", "avalanche.json");
const SECRET_ID = process.env.SECRET_ID || "weblock-api";
const REGION = process.env.AWS_REGION || "ap-northeast-2";
const FIELD = "APP_BLOCKCHAIN_AVALANCHE_OPERATOR_PRIVATE_KEY";
const WRITE = process.argv.includes("--write");

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

if (!existsSync(KEY_FILE)) die(`${path.relative(ROOT, KEY_FILE)} not found (already moved?)`);
if (!existsSync(MANIFEST)) die("deployments/avalanche.json not found — deploy first");

const keyLine = readFileSync(KEY_FILE, "utf8")
  .split("\n")
  .find((l) => l.startsWith(`${FIELD}=`));
if (!keyLine) die(`${FIELD} not found in the key file`);
const key = keyLine.slice(FIELD.length + 1).trim();

// Never print the key — only the address it derives.
let derived;
try {
  derived = new Wallet(key).address;
} catch {
  die("the value in the key file is not a valid private key");
}

const expected = JSON.parse(readFileSync(MANIFEST, "utf8")).operator;
console.log(`secret     : ${SECRET_ID} (${REGION})`);
console.log(`field      : ${FIELD}`);
console.log(`derives to : ${derived}`);
console.log(`manifest   : ${expected}`);
if (derived.toLowerCase() !== String(expected).toLowerCase()) {
  die("this key is NOT the operator in the deployment manifest — refusing to write");
}
console.log("match      : OK");

const aws = (args) =>
  execFileSync("aws", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });

const current = JSON.parse(
  aws([
    "secretsmanager", "get-secret-value",
    "--secret-id", SECRET_ID, "--region", REGION,
    "--query", "SecretString", "--output", "text",
  ]).trim(),
);
console.log(`existing   : ${Object.keys(current).length} entries, ${FIELD} ${FIELD in current ? "present (will be replaced)" : "absent (will be added)"}`);

if (!WRITE) {
  console.log("\nDry run — nothing written. Re-run with --write to apply.");
  process.exit(0);
}

const next = { ...current, [FIELD]: key };
aws([
  "secretsmanager", "put-secret-value",
  "--secret-id", SECRET_ID, "--region", REGION,
  "--secret-string", JSON.stringify(next),
]);
console.log(`\nWritten. The secret now has ${Object.keys(next).length} entries.`);
console.log("Next: rm .env.mainnet.operator-key   (the key now lives only in AWS)");
