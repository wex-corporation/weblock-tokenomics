// Greenfield WeBlock contract deployment.
// Deploys the full suite, wires roles/gates, writes a chainId-named manifest under deployments/,
// and exports ABIs under abis/ for the backend + wallet SDK to consume.
//
// Usage: npx hardhat run scripts/deploy.js --network fuji
import fs from "node:fs/promises";
import path from "node:path";
import hre from "hardhat";

const CHAIN_NAMES = {
  43113: "fuji",
  43114: "avalanche",
  43110: "avalancheSubnet",
  31337: "hardhat",
};

const role = (name) => hre.ethers?.keccak256
  ? hre.ethers.keccak256(hre.ethers.toUtf8Bytes(name))
  : null;

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

async function main() {
  const connection = await hre.network.connect();
  const { ethers } = connection;
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const networkName = CHAIN_NAMES[chainId] || `chain-${chainId}`;

  const admin = env("ADMIN_ADDRESS", deployer.address);
  const treasury = env("FOUNDATION_TREASURY_ADDRESS", deployer.address);
  const feeTreasury = env("FEE_TREASURY_ADDRESS", deployer.address);
  const operator = env("BACKEND_OPERATOR_ADDRESS", deployer.address); // backend signer (KYC/settlement/oracle/...)
  const baseUri = env("FALLBACK_RBT_URI", "ipfs://weblock/rbt/{id}.json");
  const usdrInitial = BigInt(env("USDR_INITIAL_SUPPLY", "1000000000000")); // 1,000,000 USDR
  const wftCap = BigInt(env("WFT_CAP", "1000000000000000000000000000")); // 1B * 1e18
  const navMaxDevBps = Number(env("NAV_MAX_DEVIATION_BPS", "2000"));
  const navMaxStale = Number(env("NAV_MAX_STALENESS_SECS", "86400"));
  const spotFeeBps = Number(env("SPOT_FEE_BPS", "100"));
  const deployMocks = env("DEPLOY_MOCK_STABLES", "true") === "true";

  const R = {
    MANAGER: ethers.keccak256(ethers.toUtf8Bytes("WEBLOCK_MANAGER")),
    MINTER: ethers.keccak256(ethers.toUtf8Bytes("WEBLOCK_MINTER")),
    KYC_MANAGER: ethers.keccak256(ethers.toUtf8Bytes("WEBLOCK_KYC_MANAGER")),
    OPERATOR: ethers.keccak256(ethers.toUtf8Bytes("WEBLOCK_OPERATOR")),
    TREASURY_FUNDER: ethers.keccak256(ethers.toUtf8Bytes("WEBLOCK_TREASURY_FUNDER")),
    DELINQUENCY_MANAGER: ethers.keccak256(ethers.toUtf8Bytes("WEBLOCK_DELINQUENCY_MANAGER")),
    DISTRIBUTION_MANAGER: ethers.keccak256(ethers.toUtf8Bytes("WEBLOCK_DISTRIBUTION_MANAGER")),
    SETTLEMENT: ethers.keccak256(ethers.toUtf8Bytes("WEBLOCK_SETTLEMENT")),
    FUNDING: ethers.keccak256(ethers.toUtf8Bytes("WEBLOCK_FUNDING")),
    LIQUIDATOR: ethers.keccak256(ethers.toUtf8Bytes("WEBLOCK_LIQUIDATOR")),
    MARKET_ADMIN: ethers.keccak256(ethers.toUtf8Bytes("WEBLOCK_MARKET_ADMIN")),
    ORACLE_PUBLISHER: ethers.keccak256(ethers.toUtf8Bytes("WEBLOCK_ORACLE_PUBLISHER")),
    DRAWER: ethers.keccak256(ethers.toUtf8Bytes("WEBLOCK_DRAWER")),
  };

  console.log(`Deploying WeBlock greenfield to ${networkName} (${chainId}) as ${deployer.address}`);
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`Deployer balance: ${ethers.formatEther(bal)}`);

  const deployed = {};
  async function deploy(name, args = []) {
    const f = await ethers.getContractFactory(name);
    const c = await f.deploy(...args);
    await c.waitForDeployment();
    const addr = await c.getAddress();
    deployed[name] = addr;
    console.log(`  ${name} -> ${addr}`);
    return c;
  }

  // 1) stablecoins (testnet mocks) or external addresses
  let usdcAddr = env("USDC_ADDRESS");
  let usdtAddr = env("USDT_ADDRESS");
  if (deployMocks) {
    const usdc = await deploy("MockERC20", ["USD Coin", "USDC", 6]);
    const usdt = await deploy("MockERC20", ["Tether USD", "USDT", 6]);
    usdcAddr = await usdc.getAddress();
    usdtAddr = await usdt.getAddress();
  }

  // 2) tokens
  const usdr = await deploy("USDR", [admin, usdrInitial, treasury]);
  const rbt = await deploy("RBT", [admin, baseUri]);
  const wft = await deploy("WFT", [admin, wftCap]);

  // 3) KYC + RWA
  const kyc = await deploy("KycRegistry", [admin]);
  const series = await deploy("SeriesManager", [admin, await rbt.getAddress(), await kyc.getAddress()]);
  const income = await deploy("IncomeDistributor", [admin]);

  // 4) markets
  const spot = await deploy("SpotExchange", [
    admin, await rbt.getAddress(), usdcAddr, await kyc.getAddress(), feeTreasury, spotFeeBps,
  ]);
  const nav = await deploy("NavOracle", [admin, navMaxDevBps, navMaxStale]);
  const insurance = await deploy("InsuranceFund", [admin, await usdr.getAddress()]);
  const perp = await deploy("PerpClearing", [
    admin, await usdr.getAddress(), await nav.getAddress(), await insurance.getAddress(),
  ]);

  // 5) TGE (paused)
  const wftClaim = await deploy("WftClaim", [admin, await wft.getAddress()]);

  // ---- wiring (deployer must hold DEFAULT_ADMIN_ROLE == admin) ----
  console.log("Wiring roles & gates...");
  await (await rbt.grantRole(R.MANAGER, await series.getAddress())).wait();
  await (await rbt.setGate(await series.getAddress())).wait();
  await (await rbt.setGateExempt(await spot.getAddress(), true)).wait();
  await (await insurance.grantRole(R.DRAWER, await perp.getAddress())).wait();

  // grant backend operator its operational roles (if distinct from admin)
  if (operator.toLowerCase() !== admin.toLowerCase()) {
    await (await kyc.grantRole(R.KYC_MANAGER, operator)).wait();
    await (await series.grantRole(R.OPERATOR, operator)).wait();
    await (await series.grantRole(R.TREASURY_FUNDER, operator)).wait();
    await (await series.grantRole(R.DELINQUENCY_MANAGER, operator)).wait();
    await (await income.grantRole(R.DISTRIBUTION_MANAGER, operator)).wait();
    await (await spot.grantRole(R.SETTLEMENT, operator)).wait();
    await (await nav.grantRole(R.ORACLE_PUBLISHER, operator)).wait();
    await (await perp.grantRole(R.SETTLEMENT, operator)).wait();
    await (await perp.grantRole(R.FUNDING, operator)).wait();
    await (await perp.grantRole(R.LIQUIDATOR, operator)).wait();
    await (await perp.grantRole(R.MARKET_ADMIN, operator)).wait();
    console.log(`  granted operator roles to ${operator}`);
  }

  // ---- manifest ----
  const manifest = {
    network: networkName,
    chainId,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    admin,
    treasury,
    feeTreasury,
    operator,
    stablecoins: { usdc: usdcAddr, usdt: usdtAddr },
    contracts: {
      usdr: await usdr.getAddress(),
      rbt: await rbt.getAddress(),
      wft: await wft.getAddress(),
      kycRegistry: await kyc.getAddress(),
      seriesManager: await series.getAddress(),
      incomeDistributor: await income.getAddress(),
      spotExchange: await spot.getAddress(),
      navOracle: await nav.getAddress(),
      insuranceFund: await insurance.getAddress(),
      perpClearing: await perp.getAddress(),
      wftClaim: await wftClaim.getAddress(),
    },
    params: { navMaxDevBps, navMaxStale, spotFeeBps },
  };

  const outDir = path.resolve("deployments");
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, `${networkName}.json`), JSON.stringify(manifest, null, 2));
  console.log(`Manifest -> deployments/${networkName}.json`);

  // ---- ABI export ----
  const abiDir = path.resolve("abis");
  await fs.mkdir(abiDir, { recursive: true });
  const abiNames = [
    "USDR", "RBT", "WFT", "KycRegistry", "SeriesManager", "IncomeDistributor",
    "SpotExchange", "NavOracle", "InsuranceFund", "PerpClearing", "WftClaim", "MockERC20",
  ];
  for (const n of abiNames) {
    const f = await ethers.getContractFactory(n);
    await fs.writeFile(path.join(abiDir, `${n}.json`), f.interface.formatJson());
  }
  console.log(`ABIs -> abis/ (${abiNames.length} contracts)`);
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
