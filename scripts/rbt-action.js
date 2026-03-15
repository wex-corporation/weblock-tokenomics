import {
  getDefaultSigner,
  optionalBigInt,
  optionalNumber,
  parseAddressList,
  requireEnv,
} from "./lib/runtime.js";

async function main() {
  const { ethers, signer } = await getDefaultSigner();
  const action = requireEnv("ACTION");
  const manager = await ethers.getContractAt(
    "RBTSeriesManager",
    requireEnv("RBT_MANAGER_ADDRESS"),
  );
  const tokenId = optionalBigInt("TOKEN_ID");

  switch (action) {
    case "buy": {
      const paymentToken = requireEnv("PAYMENT_TOKEN");
      const quantity = requireEnv("QUANTITY");
      const maxCost = requireEnv("MAX_COST");
      const beneficiary = process.env.BENEFICIARY || signer.address;
      const tx = await manager.buy(
        tokenId,
        paymentToken,
        quantity,
        maxCost,
        beneficiary,
      );
      await tx.wait();
      console.log(
        `Bought ${quantity} units of tokenId=${tokenId} for ${beneficiary}`,
      );
      break;
    }
    case "finalize-sale": {
      const tx = await manager.finalizeSale(tokenId);
      await tx.wait();
      console.log(`Finalized sale for tokenId=${tokenId}`);
      break;
    }
    case "cancel-sale": {
      const memo = process.env.MEMO || "cancelled by operator";
      const tx = await manager.cancelSale(tokenId, memo);
      await tx.wait();
      console.log(`Cancelled sale for tokenId=${tokenId}`);
      break;
    }
    case "fund-interest": {
      const paymentToken = requireEnv("PAYMENT_TOKEN");
      const amount = requireEnv("AMOUNT");
      const tx = await manager.fundInterest(tokenId, paymentToken, amount);
      await tx.wait();
      console.log(`Funded interest for tokenId=${tokenId}`);
      break;
    }
    case "claim-interest": {
      const paymentToken = requireEnv("PAYMENT_TOKEN");
      const tx = await manager.claimInterest(tokenId, paymentToken);
      await tx.wait();
      console.log(`Claimed interest for tokenId=${tokenId}`);
      break;
    }
    case "claim-interest-batch": {
      const paymentTokens = parseAddressList("PAYMENT_TOKENS");
      const tx = await manager.claimInterestBatch(tokenId, paymentTokens);
      await tx.wait();
      console.log(`Claimed batched interest for tokenId=${tokenId}`);
      break;
    }
    case "mark-delinquent": {
      const memo = process.env.MEMO || "delinquent";
      const tx = await manager.markDelinquent(tokenId, memo);
      await tx.wait();
      console.log(`Marked tokenId=${tokenId} delinquent`);
      break;
    }
    case "cure-delinquency": {
      const tx = await manager.cureDelinquency(tokenId);
      await tx.wait();
      console.log(`Cured delinquency for tokenId=${tokenId}`);
      break;
    }
    case "declare-default": {
      const memo = process.env.MEMO || "default";
      const tx = await manager.declareDefault(tokenId, memo);
      await tx.wait();
      console.log(`Declared default for tokenId=${tokenId}`);
      break;
    }
    case "enter-maturity": {
      const tx = await manager.enterMaturity(tokenId);
      await tx.wait();
      console.log(`Entered maturity for tokenId=${tokenId}`);
      break;
    }
    case "enable-redemption": {
      const paymentToken = requireEnv("PAYMENT_TOKEN");
      const totalAmount = requireEnv("AMOUNT");
      const tx = await manager.enableRedemption(
        tokenId,
        paymentToken,
        totalAmount,
      );
      await tx.wait();
      console.log(`Enabled redemption for tokenId=${tokenId}`);
      break;
    }
    case "redeem": {
      const paymentToken = requireEnv("PAYMENT_TOKEN");
      const quantity = requireEnv("QUANTITY");
      const tx = await manager.redeem(tokenId, paymentToken, quantity);
      await tx.wait();
      console.log(`Redeemed ${quantity} units for tokenId=${tokenId}`);
      break;
    }
    case "claim-refund": {
      const tx = await manager.claimRefund(tokenId);
      await tx.wait();
      console.log(`Claimed refund for tokenId=${tokenId}`);
      break;
    }
    case "series-info": {
      const series = await manager.getSeries(tokenId);
      console.log(series);
      break;
    }
    case "quote-buy": {
      const paymentToken = requireEnv("PAYMENT_TOKEN");
      const quantity = requireEnv("QUANTITY");
      const quote = await manager.quotePrimarySale(
        tokenId,
        paymentToken,
        quantity,
      );
      console.log(`Quote: ${quote.toString()}`);
      break;
    }
    case "payment-tokens": {
      const tokens = await manager.seriesPaymentTokens(tokenId);
      console.log(tokens);
      break;
    }
    case "create-ask": {
      const orderBook = await ethers.getContractAt(
        "RBTOrderBook",
        requireEnv("RBT_ORDERBOOK_ADDRESS"),
      );
      const paymentToken = requireEnv("PAYMENT_TOKEN");
      const quantity = requireEnv("QUANTITY");
      const pricePerUnit = requireEnv("PRICE_PER_UNIT");
      const expiry = optionalNumber(
        "EXPIRY",
        Math.floor(Date.now() / 1000) + 3600,
      );
      const tx = await orderBook.createAsk(
        tokenId,
        paymentToken,
        quantity,
        pricePerUnit,
        expiry,
      );
      await tx.wait();
      console.log(`Created ask for tokenId=${tokenId}`);
      break;
    }
    case "create-bid": {
      const orderBook = await ethers.getContractAt(
        "RBTOrderBook",
        requireEnv("RBT_ORDERBOOK_ADDRESS"),
      );
      const paymentToken = requireEnv("PAYMENT_TOKEN");
      const quantity = requireEnv("QUANTITY");
      const pricePerUnit = requireEnv("PRICE_PER_UNIT");
      const expiry = optionalNumber(
        "EXPIRY",
        Math.floor(Date.now() / 1000) + 3600,
      );
      const tx = await orderBook.createBid(
        tokenId,
        paymentToken,
        quantity,
        pricePerUnit,
        expiry,
      );
      await tx.wait();
      console.log(`Created bid for tokenId=${tokenId}`);
      break;
    }
    case "fill-order": {
      const orderBook = await ethers.getContractAt(
        "RBTOrderBook",
        requireEnv("RBT_ORDERBOOK_ADDRESS"),
      );
      const orderId = requireEnv("ORDER_ID");
      const quantity = requireEnv("QUANTITY");
      const beneficiary = process.env.BENEFICIARY || signer.address;
      const tx = await orderBook.fillOrder(orderId, quantity, beneficiary);
      await tx.wait();
      console.log(`Filled orderId=${orderId}`);
      break;
    }
    case "cancel-order": {
      const orderBook = await ethers.getContractAt(
        "RBTOrderBook",
        requireEnv("RBT_ORDERBOOK_ADDRESS"),
      );
      const orderId = requireEnv("ORDER_ID");
      const tx = await orderBook.cancelOrder(orderId);
      await tx.wait();
      console.log(`Cancelled orderId=${orderId}`);
      break;
    }
    default:
      throw new Error(`Unsupported ACTION: ${action}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
