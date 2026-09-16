// Deploy a canonical Gnosis Safe (1.4.1) on any supported chain — Fuji (43113) or
// Avalanche mainnet (43114).
//
// This generalizes scripts/deploy-safe-fuji.js, which was testnet-only and minted a
// throwaway owner key. On mainnet that behaviour is refused outright: every owner must
// be an address you already control (hardware wallets — Ledger/Trezor — on separate
// machines held by separate people), and no key material is ever generated or written.
//
// Canonical Safe 1.4.1 addresses are identical across chains (CREATE2). Verified
// on-chain present on BOTH Fuji and Avalanche C-Chain mainnet (eth_getCode, 2026-09-16):
//   SafeL2 singleton   : 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762
//   SafeProxyFactory   : 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67
//   FallbackHandler    : 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99
// The L2 singleton is used so the Safe Transaction Service (and therefore app.safe.global)
// indexes the Safe on Avalanche.
//
// Usage:
//   SAFE_OWNERS=0xA,0xB,0xC SAFE_THRESHOLD=2 \
//     npx hardhat run scripts/deploy-safe.js --network avalanche
//   DRY_RUN=true ...   → print the predicted address + plan, send nothing.
//
// Prefer app.safe.global for the real mainnet Safe if the signers are hardware wallets
// and nobody wants a scripted deploy — this script exists so the address can be created
// reproducibly from CI/an ops box. Either way the resulting Safe is byte-identical in
// configuration; record it in deployments/<network>-safe.json (see --write below).
import { writeFileSync } from "node:fs";
import path from "node:path";
import hre from "hardhat";

const SAFE_SINGLETON_141 = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762"; // SafeL2.sol 1.4.1
const SAFE_PROXY_FACTORY_141 = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
const SAFE_FALLBACK_141 = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";

const CHAIN_NAMES = { 43113: "fuji", 43114: "avalanche", 31337: "hardhat" };

const FACTORY_ABI = [
  "function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
  "function proxyCreationCode() view returns (bytes)",
  "event ProxyCreation(address indexed proxy, address singleton)",
];
const SAFE_SETUP_ABI = [
  "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function isOwner(address) view returns (bool)",
  "function VERSION() view returns (string)",
];

async function main() {
  const { ethers } = await hre.network.connect();
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const networkName = CHAIN_NAMES[chainId] || `chain-${chainId}`;
  const isMainnet = chainId === 43114;
  const dryRun = process.env.DRY_RUN === "true";

  // ---- owners / threshold -------------------------------------------------
  const owners = (process.env.SAFE_OWNERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const threshold = Number(process.env.SAFE_THRESHOLD || "0");

  if (isMainnet) {
    if (owners.length < 2) {
      throw new Error(
        "SAFE_OWNERS must list at least 2 mainnet owner addresses (comma-separated). " +
          "This script never generates keys on mainnet.",
      );
    }
    if (!(threshold >= 2 && threshold <= owners.length)) {
      throw new Error(`SAFE_THRESHOLD must be between 2 and ${owners.length} (got ${threshold || "unset"}).`);
    }
    if (owners.length === threshold && owners.length === 2) {
      // 2-of-2 has no recovery: lose either key and governance is bricked forever.
      // Allowed (it is what the Fuji rehearsal proved) but never silently.
      console.warn(
        "  WARNING 2-of-2 has no key-loss recovery. 2-of-3 or 3-of-5 is strongly advised for mainnet.\n" +
          "  Set SAFE_ALLOW_2OF2=yes to proceed.",
      );
      if (process.env.SAFE_ALLOW_2OF2 !== "yes") {
        throw new Error("Refusing a mainnet 2-of-2 without SAFE_ALLOW_2OF2=yes.");
      }
    }
  }
  if (!owners.length) {
    throw new Error("SAFE_OWNERS is required (comma-separated owner addresses).");
  }

  const seen = new Set();
  for (const o of owners) {
    if (!ethers.isAddress(o)) throw new Error(`SAFE_OWNERS contains a non-address: ${o}`);
    const k = o.toLowerCase();
    if (seen.has(k)) throw new Error(`SAFE_OWNERS contains a duplicate: ${o}`);
    seen.add(k);
    if ((await ethers.provider.getCode(o)) !== "0x") {
      console.warn(`  NOTE owner ${o} is a contract — it must support EIP-1271 to sign.`);
    }
  }
  const finalThreshold = threshold || owners.length;

  // ---- canonical infra present? ------------------------------------------
  for (const [label, a] of [
    ["singleton", SAFE_SINGLETON_141],
    ["factory", SAFE_PROXY_FACTORY_141],
    ["fallbackHandler", SAFE_FALLBACK_141],
  ]) {
    if ((await ethers.provider.getCode(a)) === "0x") {
      throw new Error(`Safe ${label} ${a} has no code on ${networkName} (${chainId})`);
    }
  }

  const safeIface = new ethers.Interface(SAFE_SETUP_ABI);
  const initializer = safeIface.encodeFunctionData("setup", [
    owners,
    finalThreshold,
    ethers.ZeroAddress,
    "0x", // no module/delegatecall setup
    SAFE_FALLBACK_141,
    ethers.ZeroAddress,
    0,
    ethers.ZeroAddress, // no payment
  ]);

  const factory = new ethers.Contract(SAFE_PROXY_FACTORY_141, FACTORY_ABI, deployer);
  const saltNonce = BigInt(process.env.SAFE_SALT || "0");

  // Predict the CREATE2 address so the team can verify it BEFORE any value moves.
  const creationCode = await factory.proxyCreationCode();
  const deploymentData = ethers.concat([
    creationCode,
    ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [SAFE_SINGLETON_141]),
  ]);
  const salt = ethers.keccak256(
    ethers.concat([ethers.keccak256(initializer), ethers.zeroPadValue(ethers.toBeHex(saltNonce), 32)]),
  );
  const predicted = ethers.getCreate2Address(
    SAFE_PROXY_FACTORY_141,
    salt,
    ethers.keccak256(deploymentData),
  );

  console.log(`Gnosis Safe ${finalThreshold}-of-${owners.length} on ${networkName} (${chainId})`);
  owners.forEach((o, i) => console.log(`  owner ${i + 1}: ${o}`));
  console.log(`  threshold : ${finalThreshold}`);
  console.log(`  saltNonce : ${saltNonce}`);
  console.log(`  predicted : ${predicted}`);
  console.log(`  sender    : ${deployer.address}`);

  if ((await ethers.provider.getCode(predicted)) !== "0x") {
    console.log(`  Safe already exists at ${predicted} — nothing to do.`);
    return;
  }
  if (dryRun) {
    console.log("  [dry-run] no transaction sent.");
    return;
  }

  const tx = await factory.createProxyWithNonce(SAFE_SINGLETON_141, initializer, saltNonce);
  const rc = await tx.wait();
  let proxy;
  for (const log of rc.logs) {
    try {
      const parsed = factory.interface.parseLog(log);
      if (parsed?.name === "ProxyCreation") {
        proxy = parsed.args.proxy;
        break;
      }
    } catch {
      /* not a factory log */
    }
  }
  if (!proxy) throw new Error("could not find ProxyCreation event");
  if (proxy.toLowerCase() !== predicted.toLowerCase()) {
    throw new Error(`deployed ${proxy} != predicted ${predicted} — stop and investigate`);
  }
  console.log(`  Safe -> ${proxy}   ${tx.hash}`);

  // Read back the live configuration rather than trusting what we sent.
  const safe = new ethers.Contract(proxy, SAFE_SETUP_ABI, ethers.provider);
  const gotOwners = await safe.getOwners();
  const gotThreshold = Number(await safe.getThreshold());
  const version = await safe.VERSION();
  console.log(`  confirmed version  : ${version}`);
  console.log(`  confirmed owners   : ${gotOwners.join(", ")}`);
  console.log(`  confirmed threshold: ${gotThreshold}`);
  if (gotThreshold !== finalThreshold || gotOwners.length !== owners.length) {
    throw new Error("on-chain Safe config does not match the requested config");
  }

  const out = {
    network: networkName,
    chainId,
    safe: proxy,
    owners: gotOwners,
    threshold: gotThreshold,
    version,
    singleton: SAFE_SINGLETON_141,
    factory: SAFE_PROXY_FACTORY_141,
    fallbackHandler: SAFE_FALLBACK_141,
    saltNonce: saltNonce.toString(),
    createdTx: tx.hash,
    createdAt: new Date().toISOString(),
    // Deliberately absent on mainnet: no owner private keys are ever produced here.
    web: `https://app.safe.global/home?safe=avax:${proxy}`,
  };
  const file = path.resolve(`deployments/${networkName}-safe.json`);
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`  manifest -> deployments/${networkName}-safe.json`);
  console.log(`  open it  -> ${out.web}`);
}

main().catch((e) => {
  console.error("ERR:", e.shortMessage || e.message);
  process.exitCode = 1;
});
