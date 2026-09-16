// Bring a fresh mainnet deployment to an operable state — WITHOUT minting anything.
//
// Deliberately different from scripts/seed-fuji.js: that one mints mock USDC and buys
// its own tokens so the testnet looks alive. On mainnet nothing is minted and nothing is
// bought; this only creates the launch RBT series, opens its sale window, registers the
// matching perp market and publishes the first NAV, so the product surfaces have real
// on-chain state to read.
//
// Every step is idempotent and gated: SEED_CONFIRM=SEED is required, and each parameter
// must be passed explicitly (no "10 USDC" style defaults that quietly become real prices).
//
// ORDERING: run this BEFORE scripts/safe-transfer-admin.js RENOUNCE_EOA=true. createSeries
// (OPERATOR), createMarket (MARKET_ADMIN) and publish (ORACLE_PUBLISHER) are all granted to
// `admin` by the constructors, i.e. to the deploy key. Once the EOA renounces, every one of
// these becomes a Safe transaction instead.
//
// Usage:
//   SEED_CONFIRM=SEED SEED_TOKEN_ID=1 SEED_PRICE=10000000 SEED_MAX_SUPPLY=10000 \
//   SEED_MATURITY=1790000000 SEED_ISSUER_TREASURY=0x... SEED_NAV=10000000 \
//     npx hardhat run scripts/seed-mainnet.js --network avalanche
import fs from "node:fs/promises";
import path from "node:path";
import hre from "hardhat";

const CHAIN_NAMES = { 43113: "fuji", 43114: "avalanche" };

function need(name) {
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error(`${name} is required on mainnet seeding`);
  return v;
}

async function main() {
  const { ethers } = await hre.network.connect();
  const [signer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const networkName = CHAIN_NAMES[chainId] || `chain-${chainId}`;

  if (process.env.SEED_CONFIRM !== "SEED") {
    throw new Error("Refusing to seed without SEED_CONFIRM=SEED.");
  }

  const manifest = JSON.parse(
    await fs.readFile(path.resolve(`deployments/${networkName}.json`), "utf8"),
  );
  const c = manifest.contracts;

  if (chainId === 43114 && manifest.mockStablecoins !== false) {
    throw new Error("manifest says mock stablecoins — refusing to seed a mainnet product on mocks");
  }

  const series = await ethers.getContractAt("SeriesManager", c.seriesManager);
  const perp = await ethers.getContractAt("PerpClearing", c.perpClearing);
  const nav = await ethers.getContractAt("NavOracle", c.navOracle);
  const kyc = await ethers.getContractAt("KycRegistry", c.kycRegistry);

  const tokenId = Number(need("SEED_TOKEN_ID"));
  const pricePerToken = BigInt(need("SEED_PRICE")); // pay-token base units (6dp)
  const maxSupply = BigInt(need("SEED_MAX_SUPPLY"));
  const maturity = BigInt(need("SEED_MATURITY")); // unix seconds
  const issuerTreasury = need("SEED_ISSUER_TREASURY");
  const navPrice = BigInt(need("SEED_NAV"));

  const now = (await ethers.provider.getBlock("latest")).timestamp;
  if (maturity <= BigInt(now)) throw new Error("SEED_MATURITY is in the past");

  console.log(`Seeding ${networkName} (${chainId}) as ${signer.address}`);
  console.log(`  series #${tokenId}  price ${pricePerToken} (6dp)  supply ${maxSupply}`);
  console.log(`  maturity ${new Date(Number(maturity) * 1000).toISOString()}  issuer ${issuerTreasury}`);

  // --- 1. KYC the addresses that must transact (operator, treasury, market makers) ---
  const toKyc = (process.env.SEED_KYC_ADDRESSES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (toKyc.length) {
    console.log(`KYC allowlist: ${toKyc.join(", ")}`);
    await (await kyc.setVerifiedBatch(toKyc, true)).wait();
  } else {
    console.log("KYC allowlist: none passed (real users are bridged by the backend from Sumsub)");
  }

  // --- 2. launch series -------------------------------------------------------------
  const existing = await series.getSeries(tokenId);
  if (Number(existing.state) === 0) {
    const saleStart = BigInt(process.env.SEED_SALE_START || String(now));
    const saleEnd = BigInt(need("SEED_SALE_END"));
    if (saleEnd <= saleStart) throw new Error("SEED_SALE_END must be after SEED_SALE_START");
    const payTokens = (process.env.SEED_PAY_TOKENS || `${manifest.stablecoins.usdc},${manifest.stablecoins.usdt}`)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const secondary = process.env.SEED_SECONDARY_ENABLED !== "false";

    await (
      await series.createSeries(
        tokenId,
        issuerTreasury,
        saleStart,
        saleEnd,
        maturity,
        pricePerToken,
        maxSupply,
        secondary,
        payTokens,
      )
    ).wait();
    console.log(`  series ${tokenId} created (pay tokens: ${payTokens.join(", ")})`);

    if (process.env.SEED_OPEN_SALE === "true") {
      await (await series.openSale(tokenId)).wait();
      console.log(`  sale OPEN for series ${tokenId}`);
    } else {
      console.log(`  sale left CLOSED — open it deliberately with SEED_OPEN_SALE=true or from the admin console`);
    }
  } else {
    console.log(`  series ${tokenId} already exists (state ${existing.state}) — skipped`);
  }

  // --- 3. perp market + first NAV ----------------------------------------------------
  if (process.env.SEED_PERP === "true") {
    const marketId = tokenId;
    const mkt = await perp.markets(marketId);
    if (!mkt.exists) {
      await (
        await perp.createMarket(
          marketId,
          Number(need("PERP_INITIAL_MARGIN_BPS")),
          Number(need("PERP_MAINTENANCE_MARGIN_BPS")),
          Number(need("PERP_TAKER_FEE_BPS")),
          Number(need("PERP_MAKER_FEE_BPS")),
          Number(need("PERP_LIQUIDATION_FEE_BPS")),
        )
      ).wait();
      console.log(`  perp market ${marketId} created`);
    } else {
      console.log(`  perp market ${marketId} already exists — skipped`);
    }
    const t = (await ethers.provider.getBlock("latest")).timestamp;
    await (await nav.publish(marketId, navPrice, BigInt(t))).wait();
    console.log(`  NAV ${navPrice} published for market ${marketId}`);
  } else {
    console.log("  perp market skipped (SEED_PERP != true)");
  }

  console.log("Seed complete. Run scripts/verify-deployment.js next.");
}

main().catch((e) => {
  console.error("ERR:", e.shortMessage || e.message);
  process.exitCode = 1;
});
