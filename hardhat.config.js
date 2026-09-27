require("dotenv").config();                  // Phase 3 — loads .env file
require("@nomicfoundation/hardhat-toolbox");
require("solidity-coverage");                // Phase 2.3 — coverage report

/** @type {import('hardhat/config').HardhatUserConfig} */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },

  networks: {
    hardhat: {
      // built-in local network used automatically by `npx hardhat test`
    },
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    // ── Phase 3: Sepolia testnet ─────────────────────────────────────────────
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },

  // ── Phase 3: Etherscan source verification ──────────────────────────────────
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY,
  },

  // ── Gas Reporter (Phase 2.4) ────────────────────────────────────────────────
  // Always enabled so the gas table appears in every `npx hardhat test` run.
  // Set COINMARKETCAP_API_KEY env var for real-time USD pricing.
  gasReporter: {
    enabled: true,
    currency: "USD",
    coinmarketcap: process.env.COINMARKETCAP_API_KEY || undefined,
    excludeContracts: ["MaliciousReceiver"], // exclude test-helper contracts
  },
};
