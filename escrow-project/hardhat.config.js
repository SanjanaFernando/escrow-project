require("@nomicfoundation/hardhat-toolbox");

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
    // Example testnet config — fill in your own RPC URL and private key
    // via a .env file if you want to deploy to Sepolia for the demo.
    // sepolia: {
    //   url: process.env.SEPOLIA_RPC_URL || "",
    //   accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    // },
  },
};
