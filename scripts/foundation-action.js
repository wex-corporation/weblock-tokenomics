import {
  getDefaultSigner,
  optionalNumber,
  parseAddressList,
  parseBigIntList,
  requireEnv,
} from "./lib/runtime.js";

async function main() {
  const { ethers } = await getDefaultSigner();
  const action = requireEnv("ACTION");

  if (action.startsWith("wft-")) {
    const wft = await ethers.getContractAt(
      "WFTToken",
      requireEnv("WFT_ADDRESS"),
    );

    switch (action) {
      case "wft-mint": {
        const tx = await wft.mint(
          requireEnv("RECIPIENT"),
          requireEnv("AMOUNT"),
        );
        await tx.wait();
        break;
      }
      case "wft-mint-locked": {
        const tx = await wft.mintLocked(
          requireEnv("RECIPIENT"),
          requireEnv("AMOUNT"),
          requireEnv("UNLOCK_TIME"),
          process.env.MEMO || "locked mint",
        );
        await tx.wait();
        break;
      }
      case "wft-airdrop": {
        const recipients = parseAddressList("RECIPIENTS");
        const amounts = parseBigIntList("AMOUNTS");
        const tx = await wft.airdrop(recipients, amounts);
        await tx.wait();
        break;
      }
      case "wft-airdrop-locked": {
        const recipients = parseAddressList("RECIPIENTS");
        const amounts = parseBigIntList("AMOUNTS");
        const tx = await wft.airdropLocked(
          recipients,
          amounts,
          requireEnv("UNLOCK_TIME"),
          process.env.MEMO || "locked airdrop",
        );
        await tx.wait();
        break;
      }
      case "wft-create-lock": {
        const tx = await wft.createLock(
          requireEnv("RECIPIENT"),
          requireEnv("AMOUNT"),
          requireEnv("UNLOCK_TIME"),
          process.env.MEMO || "manual lock",
        );
        await tx.wait();
        break;
      }
      case "wft-release-locks": {
        const lockIds = requireEnv("LOCK_IDS")
          .split(",")
          .map((value) => Number(value.trim()));
        const tx = await wft.releaseUnlockedLocks(
          requireEnv("RECIPIENT"),
          lockIds,
        );
        await tx.wait();
        break;
      }
      case "wft-revoke-lock": {
        const tx = await wft.revokeLock(
          requireEnv("RECIPIENT"),
          optionalNumber("LOCK_ID"),
        );
        await tx.wait();
        break;
      }
      default:
        throw new Error(`Unsupported ACTION: ${action}`);
    }

    console.log(`Executed ${action}`);
    return;
  }

  const usdr = await ethers.getContractAt(
    "USDRToken",
    requireEnv("USDR_ADDRESS"),
  );
  switch (action) {
    case "usdr-mint": {
      const tx = await usdr.mint(requireEnv("RECIPIENT"), requireEnv("AMOUNT"));
      await tx.wait();
      break;
    }
    case "usdr-pause": {
      const tx = await usdr.pause();
      await tx.wait();
      break;
    }
    case "usdr-unpause": {
      const tx = await usdr.unpause();
      await tx.wait();
      break;
    }
    default:
      throw new Error(`Unsupported ACTION: ${action}`);
  }

  console.log(`Executed ${action}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
