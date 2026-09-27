const { ethers } = require("hardhat");

// For the local Hardhat network demo, we deploy using the first three
// built-in test accounts as buyer (deployer), seller, and arbiter.
// For a real testnet deployment, replace SELLER_ADDRESS / ARBITER_ADDRESS
// below with real addresses (e.g. read from environment variables).
async function main() {
  const [buyer, seller, arbiter] = await ethers.getSigners();

  const SELLER_ADDRESS = process.env.SELLER_ADDRESS || seller.address;
  const ARBITER_ADDRESS = process.env.ARBITER_ADDRESS || arbiter.address;
  const DELIVERY_PERIOD_SECONDS = process.env.DELIVERY_PERIOD_SECONDS || 7 * 24 * 60 * 60; // 7 days

  console.log("Deploying Escrow with:");
  console.log("  buyer   (deployer):", buyer.address);
  console.log("  seller             :", SELLER_ADDRESS);
  console.log("  arbiter            :", ARBITER_ADDRESS);
  console.log("  delivery period (s):", DELIVERY_PERIOD_SECONDS);

  const Escrow = await ethers.getContractFactory("Escrow");
  const escrow = await Escrow.connect(buyer).deploy(
    SELLER_ADDRESS,
    ARBITER_ADDRESS,
    DELIVERY_PERIOD_SECONDS
  );
  await escrow.waitForDeployment();

  console.log("\n✅ Escrow deployed to:", await escrow.getAddress());
  console.log("   Copy this address into frontend/index.html (CONTRACT_ADDRESS) to demo it.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
