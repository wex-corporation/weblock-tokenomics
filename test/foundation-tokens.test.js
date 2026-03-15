import { expect } from "chai";
import { parseEther } from "ethers";
import hre from "hardhat";

async function expectCustomError(promise, errorName) {
  try {
    await promise;
    expect.fail(`expected custom error ${errorName}`);
  } catch (error) {
    expect(String(error)).to.contain(errorName);
  }
}

async function deployFoundationFixture(connection) {
  const { ethers: connectedEthers } = connection;
  const [admin, treasury, investor, recipient] =
    await connectedEthers.getSigners();

  const WFT = await connectedEthers.getContractFactory("WFTToken");
  const wft = await WFT.deploy(
    admin.address,
    treasury.address,
    parseEther("1000000000"),
    parseEther("1000"),
  );

  const USDR = await connectedEthers.getContractFactory("USDRToken");
  const usdr = await USDR.deploy(
    admin.address,
    treasury.address,
    5_000_000n * 10n ** 6n,
  );

  return { admin, treasury, investor, recipient, wft, usdr };
}

describe("Foundation tokens", function () {
  it("locks WFT allocations until the unlock time and supports airdrops", async function () {
    const connection = await hre.network.connect();
    const { networkHelpers } = connection;
    const { wft, investor, recipient } =
      await deployFoundationFixture(connection);

    const unlockTime = BigInt((await networkHelpers.time.latest()) + 3600);
    await wft.mintLocked(
      investor.address,
      parseEther("100"),
      unlockTime,
      "seed round",
    );

    await expectCustomError(
      wft.connect(investor).transfer(recipient.address, parseEther("1")),
      "InsufficientUnlockedBalance",
    );

    await wft.revokeLock(investor.address, 0);
    await wft.connect(investor).transfer(recipient.address, parseEther("25"));
    expect(await wft.balanceOf(recipient.address)).to.equal(parseEther("25"));

    await wft.airdrop([recipient.address], [parseEther("5")]);
    expect(await wft.balanceOf(recipient.address)).to.equal(parseEther("30"));
  });

  it("mints, pauses, and unpauses USDR as a 6-decimal stable token", async function () {
    const connection = await hre.network.connect();
    const { usdr, treasury, recipient } =
      await deployFoundationFixture(connection);

    expect(await usdr.decimals()).to.equal(6n);
    await usdr.mint(recipient.address, 500n * 10n ** 6n);
    expect(await usdr.balanceOf(recipient.address)).to.equal(500n * 10n ** 6n);

    await usdr.pause();
    await expectCustomError(
      usdr.connect(recipient).transfer(treasury.address, 1n),
      "EnforcedPause",
    );
    await usdr.unpause();
    await usdr.connect(recipient).transfer(treasury.address, 100n);
  });
});
