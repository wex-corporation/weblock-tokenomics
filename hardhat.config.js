import "dotenv/config";
import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import hardhatMocha from "@nomicfoundation/hardhat-mocha";
import hardhatNetworkHelpers from "@nomicfoundation/hardhat-network-helpers";

const accounts = process.env.DEPLOYER_PRIVATE_KEY
  ? [process.env.DEPLOYER_PRIVATE_KEY]
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
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
