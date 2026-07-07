// Prove the deployed Gnosis Safe 2-of-2 can wield WeBlock AccessControl governance — WITHOUT
// touching the live suite. Deploys a throwaway sandbox KycRegistry (admin = deployer EOA),
// transfers its DEFAULT_ADMIN_ROLE to the Safe, then drives an admin action THROUGH the Safe:
//   (1) 2-of-2 execTransaction: kyc.grantRole(KYC_MANAGER, probe)   -> MUST succeed
//   (2) 1-of-2 execTransaction (only owner A signs)                 -> MUST revert (GS020)
// This exercises the exact grantRole-via-Safe path the production migration uses.
//
// Usage: SAFE_ADDRESS=0x... npx hardhat run scripts/safe-prove-2of2.js --network fuji
import { readFileSync } from "node:fs";
import path from "node:path";
import hre from "hardhat";

const R = (name, ethers) => ethers.keccak256(ethers.toUtf8Bytes(name));
const DEFAULT_ADMIN = "0x0000000000000000000000000000000000000000000000000000000000000000";

const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function getThreshold() view returns (uint256)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)",
];
const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "data", type: "bytes" }, { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" }, { name: "nonce", type: "uint256" },
  ],
};

async function signSafeTx(wallets, domain, tx) {
  // Safe requires signatures concatenated in ASCENDING signer-address order.
  const sorted = [...wallets].sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1));
  let packed = "0x";
  for (const w of sorted) {
    const sig = await w.signTypedData(domain, SAFE_TX_TYPES, tx);
    packed += sig.slice(2);
  }
  return packed;
}

async function main() {
  const connection = await hre.network.connect();
  const { ethers } = connection;
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  const safeInfo = JSON.parse(readFileSync(path.resolve("deployments/fuji-safe.json"), "utf8"));
  const safeAddr = process.env.SAFE_ADDRESS || safeInfo.safe;
  const ownerA = deployer; // key from .env
  const ownerB = new ethers.Wallet(safeInfo.ownerB_pk_TESTNET_ONLY, ethers.provider);

  console.log(`Proving 2-of-2 governance with Safe ${safeAddr}`);
  console.log(`  owner A ${ownerA.address}  owner B ${ownerB.address}\n`);

  // 1) sandbox KycRegistry (NOT wired to anything live)
  const KycRegistry = await ethers.getContractFactory("KycRegistry");
  const kyc = await KycRegistry.deploy(deployer.address);
  await kyc.waitForDeployment();
  const kycAddr = await kyc.getAddress();
  console.log(`  sandbox KycRegistry -> ${kycAddr}`);

  // 2) hand its admin to the Safe (sandbox — deployer still admin too, but we'll rely on Safe)
  await (await kyc.grantRole(DEFAULT_ADMIN, safeAddr)).wait();
  console.log(`  granted sandbox DEFAULT_ADMIN_ROLE -> Safe`);

  const safe = new ethers.Contract(safeAddr, SAFE_ABI, deployer);
  const domain = { chainId, verifyingContract: safeAddr };
  const probe = "0x000000000000000000000000000000000000BEEF";
  const KYC_MANAGER = R("WEBLOCK_KYC_MANAGER", ethers);
  const grantData = kyc.interface.encodeFunctionData("grantRole", [KYC_MANAGER, probe]);

  const baseTx = {
    to: kycAddr, value: 0n, data: grantData, operation: 0,
    safeTxGas: 0n, baseGas: 0n, gasPrice: 0n,
    gasToken: ethers.ZeroAddress, refundReceiver: ethers.ZeroAddress,
  };

  // --- (2) NEGATIVE: single signature must revert (threshold 2) ---
  const nonce0 = await safe.nonce();
  const tx1sig = { ...baseTx, nonce: nonce0 };
  const oneSig = await signSafeTx([ownerA], domain, tx1sig);
  let oneSigReverted = false;
  try {
    await safe.execTransaction.staticCall(
      baseTx.to, baseTx.value, baseTx.data, baseTx.operation,
      baseTx.safeTxGas, baseTx.baseGas, baseTx.gasPrice, baseTx.gasToken, baseTx.refundReceiver, oneSig
    );
  } catch (e) {
    oneSigReverted = true;
    console.log(`  [negative] 1-of-2 correctly rejected: ${(e.shortMessage || e.message).slice(0, 80)}`);
  }
  if (!oneSigReverted) throw new Error("SECURITY FAIL: single signature was accepted by a 2-of-2 Safe");

  // --- (1) POSITIVE: two signatures execute ---
  const twoSig = await signSafeTx([ownerA, ownerB], domain, { ...baseTx, nonce: nonce0 });
  const execTx = await safe.execTransaction(
    baseTx.to, baseTx.value, baseTx.data, baseTx.operation,
    baseTx.safeTxGas, baseTx.baseGas, baseTx.gasPrice, baseTx.gasToken, baseTx.refundReceiver, twoSig
  );
  const rc = await execTx.wait();
  const granted = await kyc.hasRole(KYC_MANAGER, probe);
  console.log(`  [positive] 2-of-2 executed grantRole  ${execTx.hash}`);
  console.log(`  probe now has KYC_MANAGER on sandbox: ${granted}`);
  if (!granted) throw new Error("2-of-2 exec did not land the role");

  console.log("\n  PROOF COMPLETE: the deployed Gnosis Safe 2-of-2 wields AccessControl governance;");
  console.log("  one signature is insufficient, two signatures execute. Same path applies to the");
  console.log("  live suite via scripts/safe-transfer-admin.js when the team is ready to migrate.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
