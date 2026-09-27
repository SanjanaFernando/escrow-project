const { ethers } = require("hardhat");

// ─── Configuration ────────────────────────────────────────────────────────────
// For local Hardhat demo: first five built-in signers are used automatically.
// For testnet: set SELLER_ADDRESS, ARBITER1_ADDRESS, ARBITER2_ADDRESS,
//              ARBITER3_ADDRESS, and DELIVERY_PERIOD_SECONDS via environment
//              variables (read from a .env file — never commit the .env).
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const signers = await ethers.getSigners();
  const buyer = signers[0];

  const SELLER_ADDRESS =
    process.env.SELLER_ADDRESS ||
    signers[1]?.address ||
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const ARBITER1_ADDRESS =
    process.env.ARBITER1_ADDRESS ||
    signers[2]?.address ||
    "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
  const ARBITER2_ADDRESS =
    process.env.ARBITER2_ADDRESS ||
    signers[3]?.address ||
    "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
  const ARBITER3_ADDRESS =
    process.env.ARBITER3_ADDRESS ||
    signers[4]?.address ||
    "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";

  // Delivery period: default 7 days (604800 seconds)
  const DELIVERY_PERIOD_SECONDS = process.env.DELIVERY_PERIOD_SECONDS
    ? Number(process.env.DELIVERY_PERIOD_SECONDS)
    : 7 * 24 * 60 * 60;

  // Arbiter fee: default 200 bps = 2% (only charged on dispute path)
  const ARBITER_FEE_BPS = process.env.ARBITER_FEE_BPS
    ? Number(process.env.ARBITER_FEE_BPS)
    : 200;

  console.log("\nDeploying Escrow with:");
  console.log("  buyer   (deployer) :", buyer.address);
  console.log("  seller             :", SELLER_ADDRESS);
  console.log("  arbiter 1          :", ARBITER1_ADDRESS);
  console.log("  arbiter 2          :", ARBITER2_ADDRESS);
  console.log("  arbiter 3          :", ARBITER3_ADDRESS);
  console.log("  delivery period (s):", DELIVERY_PERIOD_SECONDS);
  console.log("  arbiter fee (bps)  :", ARBITER_FEE_BPS, `(${ARBITER_FEE_BPS / 100}%)`);

  const Escrow = await ethers.getContractFactory("Escrow");
  const escrow = await Escrow.connect(buyer).deploy(
    SELLER_ADDRESS,
    [ARBITER1_ADDRESS, ARBITER2_ADDRESS, ARBITER3_ADDRESS],
    DELIVERY_PERIOD_SECONDS,
    ARBITER_FEE_BPS
  );
  await escrow.waitForDeployment();

  const address = await escrow.getAddress();
  console.log("\n✅ Escrow deployed to:", address);
  console.log("   Paste this address into frontend/index.html to demo it.");
  console.log("   To verify on Etherscan (Sepolia):");
  console.log(`   npx hardhat verify --network sepolia ${address} \\`);
  console.log(`     "${SELLER_ADDRESS}" \\`);
  console.log(`     '["${ARBITER1_ADDRESS}","${ARBITER2_ADDRESS}","${ARBITER3_ADDRESS}"]' \\`);
  console.log(`     "${DELIVERY_PERIOD_SECONDS}" "${ARBITER_FEE_BPS}"`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
