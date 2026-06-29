// Seed the Fuji deployment with operable state: KYC the operator + test wallets, mint test
// stables, create a launch RBT series (open for sale), buy a few units, and stand up a perp
// market with an initial NAV. Makes the chain immediately usable by backend + frontend.
//
// Usage: npx hardhat run scripts/seed-fuji.js --network fuji
import fs from "node:fs/promises";
import path from "node:path";
import hre from "hardhat";

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

async function main() {
  const { ethers } = await hre.network.connect();
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const name = chainId === 43113 ? "fuji" : `chain-${chainId}`;
  const manifest = JSON.parse(await fs.readFile(path.resolve(`deployments/${name}.json`), "utf8"));
  const c = manifest.contracts;

  const kyc = await ethers.getContractAt("KycRegistry", c.kycRegistry);
  const series = await ethers.getContractAt("SeriesManager", c.seriesManager);
  const perp = await ethers.getContractAt("PerpClearing", c.perpClearing);
  const nav = await ethers.getContractAt("NavOracle", c.navOracle);
  const usdc = await ethers.getContractAt("MockERC20", manifest.stablecoins.usdc);

  const extra = env("SEED_KYC_ADDRESSES", "").split(",").map((s) => s.trim()).filter(Boolean);
  const toKyc = [deployer.address, ...extra];
  console.log("KYC:", toKyc.join(", "));
  await (await kyc.setVerifiedBatch(toKyc, true)).wait();

  // launch series #1 — Prime Retail Tower
  const tokenId = Number(env("SEED_TOKEN_ID", "1"));
  const existing = await series.getSeries(tokenId);
  if (Number(existing.state) === 0) {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const pricePerToken = BigInt(env("SEED_PRICE", "10000000")); // 10 USDC/RBT (6dp)
    const maxSupply = BigInt(env("SEED_MAX_SUPPLY", "10000"));
    const maturity = BigInt(now + 365 * 24 * 3600);
    await (await series.createSeries(
      tokenId, deployer.address, now - 60, now + 365 * 24 * 3600, maturity,
      pricePerToken, maxSupply, true, [manifest.stablecoins.usdc, manifest.stablecoins.usdt],
    )).wait();
    await (await series.openSale(tokenId)).wait();
    console.log(`Series ${tokenId} created + sale open (price ${pricePerToken} per RBT)`);

    // mint test USDC to deployer and buy a few units so holdings exist
    await (await usdc.mint(deployer.address, 1_000_000_000n)).wait(); // 1000 USDC
    await (await usdc.approve(c.seriesManager, 1_000_000_000n)).wait();
    await (await series.buy(tokenId, manifest.stablecoins.usdc, 25)).wait();
    console.log(`Bought 25 RBT of series ${tokenId}`);
  } else {
    console.log(`Series ${tokenId} already exists (state ${existing.state})`);
  }

  // perp market for the same series
  const marketId = tokenId;
  const m = await perp.markets(marketId);
  if (!m.exists) {
    await (await perp.createMarket(marketId, 2000, 1000, 10, 5, 200)).wait(); // 5x, 10% mm, fees, 2% liq
    console.log(`Perp market ${marketId} created`);
  }
  const t = (await ethers.provider.getBlock("latest")).timestamp;
  await (await nav.publish(marketId, BigInt(env("SEED_NAV", "10000000")), BigInt(t))).wait(); // 10 USDR/unit
  console.log(`NAV published for market ${marketId}`);
  console.log("Seed complete.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
