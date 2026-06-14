import fs from "node:fs/promises";
import path from "node:path";
import hre from "hardhat";

// Opens a perp market after deploy-perp.js: initialises the NAV oracle price and
// registers the market on PerpClearing, optionally seeding the insurance fund.
// Idempotent: skips steps already done.
//
//   PERP_MARKET_ID            (default 1)        on-chain marketId / RBT tokenId
//   PERP_INDEX_PRICE          (default 100000000) initial NAV (quote base units, USDR 6dp -> 100)
//   PERP_INITIAL_MARGIN_BPS   (default 2000)     => 5x max leverage
//   PERP_MAINT_MARGIN_BPS     (default 1000)
//   PERP_MAKER_FEE_BPS        (default 10)
//   PERP_TAKER_FEE_BPS        (default 20)
//   PERP_LIQ_FEE_BPS          (default 100)
//   PERP_INSURANCE_SEED       (optional)         USDR base units to fund the insurance fund

const CHAIN_NAMES = {
  43113: "fuji",
  43114: "avalanche",
  43110: "avalancheSubnet",
  11155111: "sepolia",
  84532: "baseSepolia",
  97: "bnbTestnet",
  195: "xlayerTestnet",
  31337: "hardhat",
};

function num(name, def) {
  return BigInt(process.env[name] || def);
}

async function main() {
  const connection = await hre.network.connect();
  const { ethers } = connection;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const networkName =
    process.env.HARDHAT_NETWORK || CHAIN_NAMES[chainId] || `chain-${chainId}`;

  const manifestPath = path.join(process.cwd(), "deployments", `${networkName}.json`);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const perp = manifest.perp?.contracts;
  if (!perp?.navOracle || !perp?.perpClearing) {
    throw new Error("Manifest has no perp deployment. Run scripts/deploy-perp.js first.");
  }

  const marketId = num("PERP_MARKET_ID", "1");
  const indexPrice = num("PERP_INDEX_PRICE", "100000000");
  const initialBps = num("PERP_INITIAL_MARGIN_BPS", "2000");
  const maintBps = num("PERP_MAINT_MARGIN_BPS", "1000");
  const makerFee = num("PERP_MAKER_FEE_BPS", "10");
  const takerFee = num("PERP_TAKER_FEE_BPS", "20");
  const liqFee = num("PERP_LIQ_FEE_BPS", "100");

  const oracle = await ethers.getContractAt("NavOracle", perp.navOracle);
  const clearing = await ethers.getContractAt("PerpClearing", perp.perpClearing);

  console.log(`Setting up perp market ${marketId} on ${networkName}`);

  if (await oracle.hasMarket(marketId)) {
    console.log(`  oracle: market ${marketId} already initialised, skipping`);
  } else {
    await (await oracle.initializeMarket(marketId, indexPrice)).wait();
    console.log(`  oracle: initialised market ${marketId} @ ${indexPrice}`);
  }

  const market = await clearing.markets(marketId);
  if (market.exists) {
    console.log(`  clearing: market ${marketId} already added, skipping`);
  } else {
    await (
      await clearing.addMarket(marketId, initialBps, maintBps, makerFee, takerFee, liqFee)
    ).wait();
    console.log(
      `  clearing: added market ${marketId} (im ${initialBps}bps, mm ${maintBps}bps)`,
    );
  }

  const seed = process.env.PERP_INSURANCE_SEED;
  if (seed && perp.insuranceFund && manifest.contracts?.usdr) {
    const usdr = await ethers.getContractAt("MockStablecoin", manifest.contracts.usdr);
    await (await usdr.approve(perp.insuranceFund, seed)).wait();
    const insurance = await ethers.getContractAt("InsuranceFund", perp.insuranceFund);
    await (await insurance.fund(seed)).wait();
    console.log(`  insurance: funded ${seed}`);
  }

  console.log("Perp market setup complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
