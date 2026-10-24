require("dotenv").config();
require("@nomicfoundation/hardhat-toolbox");
require("@openzeppelin/hardhat-upgrades");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        // Low runs: this implementation sits close to the 24,576-byte EIP-170
        // ceiling, so deploy size is the binding constraint, not call gas.
        runs: 1,
      },
      viaIR: true,
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
      hardfork: "cancun",
      // Only the test mock that extends the vault (DexFeeVaultV2Mock) is above EIP-170; the real contracts are
      // checked against the limit in test/ContractSize.test.js. Fork rehearsals (FORK=1) keep the real limit.
      allowUnlimitedContractSize: !process.env.FORK,
      // FORK=1 runs the local network against real LitVM state, so an upgrade
      // can be rehearsed end-to-end before anything is broadcast for real.
      ...(process.env.FORK
        ? {
            forking: {
              url: process.env.LITVM_RPC_URL || "https://liteforge.rpc.caldera.xyz/infra-partner-http",
              ...(process.env.FORK_BLOCK ? { blockNumber: Number(process.env.FORK_BLOCK) } : {}),
            },
            // Hardhat has no built-in hardfork history for chain 4441, so it
            // refuses to execute against historical blocks without being told
            // which fork was active. LitVM is a Caldera rollup running cancun.
            chains: {
              4441: { hardforkHistory: { cancun: 0 } },
            },
          }
        : {}),
    },
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    litvm: {
      url: process.env.LITVM_RPC_URL || "https://liteforge.rpc.caldera.xyz/infra-partner-http",
      chainId: 4441,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    arbitrum: {
      url: process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
      chainId: 42161,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: {
      arbitrumOne: process.env.ARBISCAN_API_KEY || "",
    },
  },
};
