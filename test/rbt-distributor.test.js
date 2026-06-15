import { expect } from "chai";
import { concat, keccak256, solidityPacked } from "ethers";
import hre from "hardhat";

async function expectCustomError(promise, errorName) {
  try {
    await promise;
    expect.fail(`expected custom error ${errorName}`);
  } catch (error) {
    expect(String(error)).to.contain(errorName);
  }
}

// Off-chain merkle mirroring backend MerkleTree.java (double-hashed packed leaf, sorted pairs).
// This test cross-validates that the backend's proof generation verifies against the on-chain
// OZ MerkleProof in RbtDistributor.
function leafOf(addr, amount) {
  return keccak256(keccak256(solidityPacked(["address", "uint256"], [addr, amount])));
}
function hashPair(a, b) {
  return a.toLowerCase() <= b.toLowerCase()
    ? keccak256(concat([a, b]))
    : keccak256(concat([b, a]));
}
function buildRoot(leaves) {
  let level = [...leaves];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0];
}
function proofFor(leaves, index) {
  const proof = [];
  let level = [...leaves];
  let idx = index;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        if (i === idx) proof.push(level[i + 1]);
        else if (i + 1 === idx) proof.push(level[i]);
        next.push(hashPair(level[i], level[i + 1]));
      } else {
        next.push(level[i]);
      }
    }
    idx = Math.floor(idx / 2);
    level = next;
  }
  return proof;
}

describe("RbtDistributor", function () {
  async function deploy() {
    const connection = await hre.network.connect();
    const { ethers } = connection;
    const [admin, alice, bob, carol] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockStablecoin");
    const usdc = await Mock.deploy("USD Coin", "USDC", 6);

    const Dist = await ethers.getContractFactory("RbtDistributor");
    const dist = await Dist.deploy(admin.address);

    return { ethers, admin, alice, bob, carol, usdc, dist };
  }

  it("lets eligible holders claim their pro-rata amount via proof", async function () {
    const { admin, alice, bob, carol, usdc, dist } = await deploy();

    const claims = [
      { addr: alice.address, amount: 500_000n },
      { addr: bob.address, amount: 300_000n },
      { addr: carol.address, amount: 200_000n },
    ];
    const total = 1_000_000n;
    const leaves = claims.map((c) => leafOf(c.addr, c.amount));
    const root = buildRoot(leaves);

    await usdc.mint(admin.address, total);
    await usdc.approve(dist.target, total);
    await dist.createRound(1, usdc.target, root, total);

    // alice claims
    await dist.connect(alice).claim(1, claims[0].amount, proofFor(leaves, 0));
    expect(await usdc.balanceOf(alice.address)).to.equal(claims[0].amount);

    // bob claims
    await dist.connect(bob).claim(1, claims[1].amount, proofFor(leaves, 1));
    expect(await usdc.balanceOf(bob.address)).to.equal(claims[1].amount);

    const round = await dist.rounds(1);
    expect(round.claimed).to.equal(claims[0].amount + claims[1].amount);
  });

  it("reverts on double claim", async function () {
    const { admin, alice, bob, carol, usdc, dist } = await deploy();
    const claims = [
      { addr: alice.address, amount: 500_000n },
      { addr: bob.address, amount: 300_000n },
      { addr: carol.address, amount: 200_000n },
    ];
    const leaves = claims.map((c) => leafOf(c.addr, c.amount));
    const root = buildRoot(leaves);
    await usdc.mint(admin.address, 1_000_000n);
    await usdc.approve(dist.target, 1_000_000n);
    await dist.createRound(1, usdc.target, root, 1_000_000n);

    await dist.connect(alice).claim(1, 500_000n, proofFor(leaves, 0));
    await expectCustomError(
      dist.connect(alice).claim(1, 500_000n, proofFor(leaves, 0)),
      "AlreadyClaimed",
    );
  });

  it("reverts on a forged amount", async function () {
    const { admin, alice, bob, carol, usdc, dist } = await deploy();
    const claims = [
      { addr: alice.address, amount: 500_000n },
      { addr: bob.address, amount: 300_000n },
      { addr: carol.address, amount: 200_000n },
    ];
    const leaves = claims.map((c) => leafOf(c.addr, c.amount));
    const root = buildRoot(leaves);
    await usdc.mint(admin.address, 1_000_000n);
    await usdc.approve(dist.target, 1_000_000n);
    await dist.createRound(1, usdc.target, root, 1_000_000n);

    await expectCustomError(
      dist.connect(alice).claim(1, 999_999n, proofFor(leaves, 0)),
      "InvalidProof",
    );
  });
});
