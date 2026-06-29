// On-chain proof of the core-loop rent payout on Fuji: open a 1-holder income round and claim it.
// Single signer (deployer = the only holder in this round). Usage:
//   npx hardhat run scripts/smoke-income-fuji.js --network fuji
import fs from "node:fs";
import hre from "hardhat";

async function main() {
  const { ethers } = await hre.network.connect();
  const [op] = await ethers.getSigners();
  const m = JSON.parse(fs.readFileSync("deployments/fuji.json", "utf8"));
  const usdc = await ethers.getContractAt("MockERC20", m.stablecoins.usdc);
  const income = await ethers.getContractAt("IncomeDistributor", m.contracts.incomeDistributor);

  const amount = 5_000_000n; // 5 USDC payout to the single holder
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const inner = ethers.keccak256(coder.encode(["address", "uint256"], [op.address, amount]));
  const leaf = ethers.keccak256(inner);
  const root = leaf; // single-leaf tree => root == leaf, proof == []
  const roundId = BigInt(Math.floor(Date.parse(m.deployedAt) / 1000)); // unique-ish round id

  console.log("Operator:", op.address);
  console.log("Round:", roundId.toString(), "amount:", amount.toString());

  await (await usdc.mint(op.address, amount)).wait();
  await (await usdc.approve(m.contracts.incomeDistributor, amount)).wait();
  const open = await (await income.openRound(roundId, m.stablecoins.usdc, root, amount, 202606)).wait();
  console.log("openRound tx:", open.hash);

  const before = await usdc.balanceOf(op.address);
  const claim = await (await income.claim(roundId, amount, [])).wait();
  console.log("claim tx:", claim.hash);
  const after = await usdc.balanceOf(op.address);
  console.log("USDC delta on claim:", (after - before).toString(), "(expect", amount.toString() + ")");
  console.log(after - before === amount ? "CORE-LOOP PAYOUT VERIFIED ON FUJI ✓" : "MISMATCH ✗");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
