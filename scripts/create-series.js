import hre from "hardhat";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function asBool(value, defaultValue = false) {
  if (value == null) {
    return defaultValue;
  }
  return value.toLowerCase() === "true";
}

async function main() {
  const connection = await hre.network.connect();
  const { ethers } = connection;
  const managerAddress = requireEnv("RBT_MANAGER_ADDRESS");

  const manager = await ethers.getContractAt(
    "RBTSeriesManager",
    managerAddress,
  );
  const paymentTokens = requireEnv("PAYMENT_TOKENS")
    .split(",")
    .map((value) => value.trim());
  const unitPrices = requireEnv("UNIT_PRICES")
    .split(",")
    .map((value) => BigInt(value.trim()));

  if (paymentTokens.length !== unitPrices.length) {
    throw new Error("PAYMENT_TOKENS and UNIT_PRICES must have the same length");
  }

  const params = {
    tokenId: BigInt(requireEnv("TOKEN_ID")),
    saleStart: Number(requireEnv("SALE_START")),
    saleEnd: Number(requireEnv("SALE_END")),
    maturityDate: Number(requireEnv("MATURITY_DATE")),
    maxSupply: BigInt(requireEnv("MAX_SUPPLY")),
    issuerTreasury: requireEnv("ISSUER_TREASURY"),
    secondaryTradingEnabled: asBool(
      process.env.SECONDARY_TRADING_ENABLED,
      true,
    ),
    propertyCode: requireEnv("PROPERTY_CODE"),
    propertyName: requireEnv("PROPERTY_NAME"),
    roundNumber: Number(requireEnv("ROUND_NUMBER")),
    roundLabel: requireEnv("ROUND_LABEL"),
    metadataURI: requireEnv("METADATA_URI"),
  };

  await (await manager.createSeries(params, paymentTokens, unitPrices)).wait();
  console.log(
    `Created series ${params.roundLabel} (tokenId=${params.tokenId})`,
  );

  if (asBool(process.env.OPEN_SALE, true)) {
    await (await manager.openSale(params.tokenId)).wait();
    console.log(`Opened sale for tokenId=${params.tokenId}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
