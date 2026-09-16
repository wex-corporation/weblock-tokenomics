import "dotenv/config";
import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import hardhatMocha from "@nomicfoundation/hardhat-mocha";
import hardhatNetworkHelpers from "@nomicfoundation/hardhat-network-helpers";

const accounts = process.env.DEPLOYER_PRIVATE_KEY
  ? [process.env.DEPLOYER_PRIVATE_KEY]
  : [];

// Mainnet uses its OWN key variable so a testnet key left in .env can never sign a
// 43114 transaction by accident. Falls back to nothing (not to DEPLOYER_PRIVATE_KEY).
const mainnetAccounts = process.env.MAINNET_DEPLOYER_PRIVATE_KEY
  ? [process.env.MAINNET_DEPLOYER_PRIVATE_KEY]
  : [];

/** @type {import('hardhat/config').HardhatUserConfig} */
const config = {
  plugins: [hardhatEthers, hardhatNetworkHelpers, hardhatMocha],
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {
      type: "edr-simulated",
      chainId: 31337,
    },
    avalancheSubnet: {
      type: "http",
      url:
        process.env.AVALANCHE_SUBNET_RPC_URL ||
        "http://127.0.0.1:9650/ext/bc/C/rpc",
      chainId: Number(process.env.AVALANCHE_SUBNET_CHAIN_ID || 43110),
      accounts,
    },
    fuji: {
      type: "http",
      url:
        process.env.FUJI_RPC_URL ||
        "https://api.avax-test.network/ext/bc/C/rpc",
      chainId: 43113,
      accounts,
    },
    // Avalanche C-Chain mainnet. The public API node is rate-limited; set
    // AVALANCHE_RPC_URL to a dedicated endpoint (Infura/Ankr/QuickNode/Blockdaemon)
    // before deploying — a dropped request mid-deploy leaves a half-wired suite.
    avalanche: {
      type: "http",
      url: process.env.AVALANCHE_RPC_URL || "https://api.avax.network/ext/bc/C/rpc",
      chainId: 43114,
      accounts: mainnetAccounts,
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
