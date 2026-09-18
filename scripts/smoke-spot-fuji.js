// On-chain proof of the SPOT trade flow on Fuji: operator (seller, holds RBT) + an ephemeral
// buyer sign EIP-712 spot orders off-chain; the operator (SETTLEMENT_ROLE) settles them on-chain;
// we verify RBT and USDC actually moved. Mirrors exactly what the frontend's signSpotOrder +
// backend SpotSettlementGateway do. Usage: npx hardhat run scripts/smoke-spot-fuji.js --network fuji
import fs from "node:fs";
import hre from "hardhat";

async function main() {
  const { ethers } = await hre.network.connect();
  const [op] = await ethers.getSigners(); // operator = seller + SETTLEMENT_ROLE
  const m = JSON.parse(fs.readFileSync("deployments/fuji.json", "utf8"));
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const usdc = await ethers.getContractAt("MockERC20", m.stablecoins.usdc);
  const rbt = await ethers.getContractAt("RBT", m.contracts.rbt);
  const kyc = await ethers.getContractAt("KycRegistry", m.contracts.kycRegistry);
  const spot = await ethers.getContractAt("SpotExchange", m.contracts.spotExchange);
  const tokenId = 1n;

  // ephemeral buyer, funded with a little AVAX for its one approve tx
  const buyer = ethers.Wallet.createRandom().connect(ethers.provider);
  console.log("operator(seller):", op.address, " buyer:", buyer.address);
  await (await op.sendTransaction({ to: buyer.address, value: ethers.parseEther("0.05") })).wait();

  // operator preconditions: KYC buyer, mint USDC to buyer, approve RBT operator, ensure RBT balance
  await (await kyc.setVerifiedBatch([op.address, buyer.address], true)).wait();
  const price = 11_000_000n; // 11 USDC / RBT
  const amount = 1n;
  await (await usdc.mint(buyer.address, price * amount * 2n)).wait();
  await (await rbt.setApprovalForAll(m.contracts.spotExchange, true)).wait();
  await (await usdc.connect(buyer).approve(m.contracts.spotExchange, price * amount * 2n)).wait();

  const sellerRbt = await rbt.balanceOf(op.address, tokenId);
  if (sellerRbt < amount) throw new Error(`operator holds ${sellerRbt} RBT of series ${tokenId}; need ${amount}`);

  // EIP-712 signed orders (gas-free) — exactly the frontend's signSpotOrder
  const domain = { name: "WeBlockSpot", version: "1", chainId, verifyingContract: m.contracts.spotExchange };
  const types = { Order: [
    { name: "trader", type: "address" }, { name: "marketId", type: "uint256" },
    { name: "isBuy", type: "bool" }, { name: "price", type: "uint256" },
    { name: "amount", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "expiry", type: "uint256" },
  ]};
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const nonce = BigInt(now);
  const sell = { trader: op.address, marketId: tokenId, isBuy: false, price, amount, nonce, expiry: BigInt(now + 3600) };
  const buy = { trader: buyer.address, marketId: tokenId, isBuy: true, price, amount, nonce, expiry: BigInt(now + 3600) };
  const sellSig = await op.signTypedData(domain, types, sell);
  const buySig = await buyer.signTypedData(domain, types, buy);

  const buyerRbtBefore = await rbt.balanceOf(buyer.address, tokenId);
  const sellerUsdcBefore = await usdc.balanceOf(op.address);

  const tx = await spot.settle(buy, buySig, sell, sellSig, amount, price);
  const rec = await tx.wait();
  console.log("settle tx:", rec.hash);

  const buyerRbtAfter = await rbt.balanceOf(buyer.address, tokenId);
  const sellerUsdcAfter = await usdc.balanceOf(op.address);
  const fee = (price * amount * 100n) / 10_000n; // 1%
  console.log("buyer RBT +", (buyerRbtAfter - buyerRbtBefore).toString(), "(expect", amount.toString() + ")");
  console.log("seller USDC +", (sellerUsdcAfter - sellerUsdcBefore).toString(), "(expect", (price * amount - fee).toString() + ")");
  const ok = buyerRbtAfter - buyerRbtBefore === amount && sellerUsdcAfter - sellerUsdcBefore === price * amount - fee;
  console.log(ok ? "SPOT TRADE FLOW VERIFIED ON FUJI ✓" : "MISMATCH ✗");
}

main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exitCode = 1; });
