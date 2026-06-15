import { expect } from "chai";
import hre from "hardhat";

async function expectCustomError(promise, errorName) {
  try {
    await promise;
    expect.fail(`expected custom error ${errorName}`);
  } catch (error) {
    expect(String(error)).to.contain(errorName);
  }
}

const FUTURE = 9_999_999_999n;
const PRICE = 2_000_000n; // $2.00 (USDC 6dp) per RBT
const QTY = 10n;

describe("RbtSpotExchange", function () {
  async function deploy() {
    const connection = await hre.network.connect();
    const { ethers } = connection;
    const [admin, buyer, seller, treasury] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockStablecoin");
    const usdc = await Mock.deploy("USD Coin", "USDC", 6);

    const RBT = await ethers.getContractFactory("RealEstateBackedToken");
    const rbt = await RBT.deploy(admin.address, "ipfs://fallback/{id}.json");
    await rbt.mint(seller.address, 1n, 100n, "0x"); // admin holds MANAGER_ROLE

    const Exchange = await ethers.getContractFactory("RbtSpotExchange");
    const exchange = await Exchange.deploy(
      admin.address,
      rbt.target,
      usdc.target,
      treasury.address,
      100, // 1% per side
    );

    await usdc.mint(buyer.address, 1_000_000_000n);
    await usdc.connect(buyer).approve(exchange.target, 1_000_000_000n);
    await rbt.connect(seller).setApprovalForAll(exchange.target, true);

    const { chainId } = await ethers.provider.getNetwork();
    const domain = {
      name: "WeBlockSpot",
      version: "1",
      chainId,
      verifyingContract: exchange.target,
    };
    const types = {
      SpotOrder: [
        { name: "trader", type: "address" },
        { name: "marketId", type: "uint256" },
        { name: "isBuy", type: "bool" },
        { name: "price", type: "uint256" },
        { name: "amount", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "expiry", type: "uint256" },
      ],
    };

    const buyOrder = {
      trader: buyer.address,
      marketId: 1n,
      isBuy: true,
      price: PRICE,
      amount: QTY,
      nonce: 1n,
      expiry: FUTURE,
    };
    const sellOrder = {
      trader: seller.address,
      marketId: 1n,
      isBuy: false,
      price: PRICE,
      amount: QTY,
      nonce: 1n,
      expiry: FUTURE,
    };
    const buySig = await buyer.signTypedData(domain, types, buyOrder);
    const sellSig = await seller.signTypedData(domain, types, sellOrder);

    return {
      ethers, admin, buyer, seller, treasury, usdc, rbt, exchange,
      buyOrder, sellOrder, buySig, sellSig,
    };
  }

  it("atomically swaps RBT for USDC with both-side fee", async function () {
    const { admin, buyer, seller, treasury, usdc, rbt, exchange, buyOrder, sellOrder, buySig, sellSig } =
      await deploy();

    await exchange
      .connect(admin)
      .settle({ buyOrder, buySig, sellOrder, sellSig, amount: QTY, price: PRICE });

    const gross = QTY * PRICE; // 20,000,000
    const fee = gross / 100n; // 1% = 200,000
    expect(await rbt.balanceOf(buyer.address, 1n)).to.equal(QTY);
    expect(await rbt.balanceOf(seller.address, 1n)).to.equal(90n);
    expect(await usdc.balanceOf(seller.address)).to.equal(gross - fee); // 19,800,000
    expect(await usdc.balanceOf(treasury.address)).to.equal(fee * 2n); // 400,000
    expect(await usdc.balanceOf(buyer.address)).to.equal(1_000_000_000n - (gross + fee));
  });

  it("rejects a tampered signature / wrong signer", async function () {
    const { admin, exchange, buyOrder, sellOrder, sellSig } = await deploy();
    await expectCustomError(
      exchange
        .connect(admin)
        .settle({ buyOrder, buySig: sellSig, sellOrder, sellSig, amount: QTY, price: PRICE }),
      "BadSignature",
    );
  });

  it("prevents over-filling an order", async function () {
    const { admin, exchange, buyOrder, sellOrder, buySig, sellSig } = await deploy();
    await expectCustomError(
      exchange
        .connect(admin)
        .settle({ buyOrder, buySig, sellOrder, sellSig, amount: QTY + 1n, price: PRICE }),
      "Overfill",
    );
  });

  it("only the operator can settle", async function () {
    const { buyer, exchange, buyOrder, sellOrder, buySig, sellSig } = await deploy();
    await expectCustomError(
      exchange
        .connect(buyer)
        .settle({ buyOrder, buySig, sellOrder, sellSig, amount: QTY, price: PRICE }),
      "AccessControl",
    );
  });
});
