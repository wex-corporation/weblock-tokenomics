// Deploy a REAL Gnosis Safe 2-of-2 on Avalanche Fuji using the canonical Safe 1.4.1 singleton
// + SafeProxyFactory that are already deployed on Fuji. Proves the WeBlock admin authority can be
// governed by a 2-of-2 Safe. Owner A = deployer EOA; Owner B = a fresh key (printed once, testnet).
//
// Canonical Safe 1.4.1 on Fuji (all verified present via eth_getCode):
//   SafeL2 singleton   : 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762  (used — L2 variant emits
//                        events the Safe Transaction Service indexes on Avalanche)
//   SafeProxyFactory   : 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67
//   Fallback handler   : 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import hre from "hardhat";

// Safe 1.4.1 canonical (same across chains via CREATE2). Verified deployed on Fuji.
const SAFE_SINGLETON_141 = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762"; // SafeL2.sol 1.4.1
const SAFE_PROXY_FACTORY_141 = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67"; // SafeProxyFactory 1.4.1
const SAFE_FALLBACK_141 = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99"; // CompatibilityFallbackHandler 1.4.1

const FACTORY_ABI = [
  "function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
  "event ProxyCreation(address indexed proxy, address singleton)",
];
const SAFE_SETUP_ABI = [
  "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function isOwner(address) view returns (bool)",
];

async function main() {
  const connection = await hre.network.connect();
  const { ethers } = connection;
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  if (chainId !== 43113) throw new Error(`this script is Fuji-only (got ${chainId})`);

  // Owner B: deterministic-from-env or fresh. On testnet we generate + print it (never do this on mainnet).
  let ownerBpk = process.env.SAFE_OWNER_B_PK;
  let ownerB;
  if (ownerBpk) {
    ownerB = new ethers.Wallet(ownerBpk).address;
  } else {
    const w = ethers.Wallet.createRandom();
    ownerBpk = w.privateKey;
    ownerB = w.address;
  }
  const owners = [deployer.address, ownerB];
  const threshold = 2;

  // verify canonical Safe infra is present on-chain
  for (const [label, a] of [["singleton", SAFE_SINGLETON_141], ["factory", SAFE_PROXY_FACTORY_141], ["fallback", SAFE_FALLBACK_141]]) {
    const code = await ethers.provider.getCode(a);
    if (code === "0x") throw new Error(`Safe ${label} ${a} has no code on Fuji`);
  }

  const safeIface = new ethers.Interface(SAFE_SETUP_ABI);
  const initializer = safeIface.encodeFunctionData("setup", [
    owners, threshold,
    ethers.ZeroAddress, "0x",       // no delegatecall module setup
    SAFE_FALLBACK_141,
    ethers.ZeroAddress, 0, ethers.ZeroAddress, // no payment
  ]);

  const factory = new ethers.Contract(SAFE_PROXY_FACTORY_141, FACTORY_ABI, deployer);
  const saltNonce = BigInt(Math.floor(Number(process.env.SALT || "70707"))); // stable-ish, testnet
  console.log(`Deploying Safe 2-of-2 on Fuji`);
  console.log(`  owner A (deployer): ${deployer.address}`);
  console.log(`  owner B (fresh)   : ${ownerB}`);
  const tx = await factory.createProxyWithNonce(SAFE_SINGLETON_141, initializer, saltNonce);
  const rc = await tx.wait();
  // parse ProxyCreation
  let proxy;
  for (const log of rc.logs) {
    try {
      const parsed = factory.interface.parseLog(log);
      if (parsed?.name === "ProxyCreation") { proxy = parsed.args.proxy; break; }
    } catch {}
  }
  if (!proxy) throw new Error("could not find ProxyCreation event");
  console.log(`  Safe proxy -> ${proxy}   ${tx.hash}`);

  // sanity: read back owners/threshold
  const safe = new ethers.Contract(proxy, SAFE_SETUP_ABI, ethers.provider);
  const gotOwners = await safe.getOwners();
  const gotThreshold = await safe.getThreshold();
  console.log(`  confirmed owners: ${gotOwners.join(", ")}`);
  console.log(`  confirmed threshold: ${gotThreshold}`);

  // persist (testnet only — includes owner B key so the 2-of-2 can be rehearsed)
  const out = {
    network: "fuji", chainId, safe: proxy,
    owners, threshold,
    singleton: SAFE_SINGLETON_141, factory: SAFE_PROXY_FACTORY_141, fallbackHandler: SAFE_FALLBACK_141,
    ownerB_pk_TESTNET_ONLY: ownerBpk,
    createdTx: tx.hash,
  };
  writeFileSync(path.resolve("deployments/fuji-safe.json"), JSON.stringify(out, null, 2));
  console.log(`  manifest -> deployments/fuji-safe.json (contains owner B testnet key)`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
