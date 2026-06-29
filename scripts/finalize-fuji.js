// Finalize the launch series sale (Sale -> Active) so secondary spot trading is enabled.
// Usage: npx hardhat run scripts/finalize-fuji.js --network fuji
import fs from "node:fs";
import hre from "hardhat";

async function main() {
  const { ethers } = await hre.network.connect();
  const m = JSON.parse(fs.readFileSync("deployments/fuji.json", "utf8"));
  const series = await ethers.getContractAt("SeriesManager", m.contracts.seriesManager);
  const tokenId = Number(process.env.SEED_TOKEN_ID || "1");
  const s = await series.getSeries(tokenId);
  console.log(`series ${tokenId} state before: ${s.state} (2=Sale,3=Active)`);
  if (Number(s.state) === 2) {
    const tx = await series.finalizeSale(tokenId);
    await tx.wait();
    console.log(`finalizeSale tx: ${tx.hash}`);
  } else {
    console.log("not in Sale state; skipping");
  }
  const after = await series.getSeries(tokenId);
  console.log(`series ${tokenId} state after: ${after.state}  secondaryEnabled: ${after.secondaryEnabled}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
