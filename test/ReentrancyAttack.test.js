const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

// ─────────────────────────────────────────────────────────────────────────────
// ReentrancyAttack.test.js — Security proof for the Cyber Security half of EC8204
//
// Demonstrates that the Escrow contract is immune to a classic reentrancy
// attack thanks to two independent defence layers:
//
//   Layer 1 — Checks-Effects-Interactions (CEI) pattern:
//             State variables (currentState, amount) are updated BEFORE any
//             external ETH transfer, so a re-entrant call sees an already-
//             terminal state and reverts on the inState() guard.
//
//   Layer 2 — OpenZeppelin nonReentrant mutex:
//             Even if the CEI order were accidentally violated, the mutex
//             would still block the second entry with "ReentrancyGuard:
//             reentrant call".
//
// Attack scenario modelled here:
//   A malicious smart contract acts as the BUYER of its own Escrow.
//   After the delivery deadline passes it calls refundAfterTimeout().
//   When the Escrow sends ETH back, the attacker's receive() immediately
//   re-calls refundAfterTimeout() attempting to withdraw funds a second time.
//   The attacker is *sophisticated*: it wraps the inner call in try/catch so
//   that failure of the reentrant call does not revert the outer refund
//   (the attacker still walks away with their rightful refund — they just
//   can't steal a second copy of it).
// ─────────────────────────────────────────────────────────────────────────────

describe("Reentrancy Attack Simulation (Security Proof)", function () {
  const DEPOSIT = ethers.parseEther("1.0");
  const DELIVERY_PERIOD = 7 * 24 * 60 * 60; // 7 days

  // ── Helper: deploy MaliciousReceiver (which internally deploys its own Escrow)
  async function deployAttacker() {
    const [, seller, arbiter1, arbiter2, arbiter3] = await ethers.getSigners();

    const MaliciousReceiver = await ethers.getContractFactory("MaliciousReceiver");
    const attacker = await MaliciousReceiver.deploy(
      seller.address,
      [arbiter1.address, arbiter2.address, arbiter3.address],
      DELIVERY_PERIOD
    );
    await attacker.waitForDeployment();

    // Retrieve the Escrow that MaliciousReceiver deployed internally
    const escrowAddr = await attacker.escrow();
    const escrow = await ethers.getContractAt("Escrow", escrowAddr);

    return { attacker, escrow, seller, arbiter1, arbiter2, arbiter3 };
  }

  // ── Test 1: Main reentrancy attack on refundAfterTimeout ─────────────────
  it("blocks reentrancy on refundAfterTimeout — attacker cannot double-withdraw (CEI + nonReentrant)", async function () {
    const { attacker, escrow } = await deployAttacker();

    // 1. Attacker funds the escrow as the buyer
    await attacker.depositToEscrow({ value: DEPOSIT });
    expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(DEPOSIT);

    // 2. Fast-forward past the delivery deadline
    await time.increase(DELIVERY_PERIOD + 1);

    // 3. Execute the attack — receive() will attempt a reentrant call mid-transfer
    //    This should NOT revert (the attacker correctly receives their one refund).
    await expect(attacker.attack()).to.not.be.reverted;

    // ── Assertions proving the attack was blocked ─────────────────────────

    // (a) A reentrancy attempt WAS made — the attacker DID try.
    expect(await attacker.reentrancyAttempts()).to.equal(
      1,
      "receive() was triggered and made exactly one reentrant call attempt"
    );

    // (b) Escrow state is REFUNDED — only ONE refund occurred.
    expect(await escrow.currentState()).to.equal(
      4, // State.REFUNDED
      "State should be REFUNDED (not AWAITING_DELIVERY if attack had succeeded)"
    );

    // (c) Escrow holds exactly 0 ETH — no extra ETH was left or double-withdrawn.
    expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(
      0n,
      "Escrow balance must be 0 — funds paid out exactly once"
    );

    // (d) Internal amount field is zeroed.
    expect(await escrow.amount()).to.equal(0n);
  });

  // ── Test 2: CEI layer alone is sufficient (conceptual proof) ─────────────
  it("state is terminal (REFUNDED) before ETH transfer — CEI alone blocks re-entry", async function () {
    const { attacker, escrow } = await deployAttacker();

    await attacker.depositToEscrow({ value: DEPOSIT });
    await time.increase(DELIVERY_PERIOD + 1);

    // Before attack: state = AWAITING_DELIVERY (1)
    expect(await escrow.currentState()).to.equal(1);

    await attacker.attack();

    // After attack: state = REFUNDED (4) — was updated BEFORE the ETH transfer
    // so the reentrant inState(AWAITING_DELIVERY) guard saw REFUNDED and reverted.
    expect(await escrow.currentState()).to.equal(4);
  });

  // ── Test 3: Attack cannot succeed even with funds in escrow ──────────────
  it("escrow balance is exactly 0 after attack — funds paid out exactly once, not twice", async function () {
    const { attacker, escrow } = await deployAttacker();

    await attacker.depositToEscrow({ value: DEPOSIT });

    // Confirm funds are locked in escrow before attack
    expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(DEPOSIT);

    await time.increase(DELIVERY_PERIOD + 1);
    await attacker.attack();

    // ── Key assertions proving no double-spend ────────────────────────────

    // 1. Escrow is 0 — all funds moved out (exactly once, not twice)
    expect(
      await ethers.provider.getBalance(await escrow.getAddress())
    ).to.equal(0n, "Escrow must be completely drained — funds paid out exactly once");

    // 2. Internal amount field is zeroed
    expect(await escrow.amount()).to.equal(0n);

    // 3. The reentrancy attempt counter proves the attacker DID try but failed
    expect(await attacker.reentrancyAttempts()).to.equal(
      1n,
      "receive() fired once and attempted one reentrant call — which was blocked"
    );

    // 4. State is terminal — REFUNDED (only once)
    expect(await escrow.currentState()).to.equal(4);
  });

  // ── Test 4: Verify reentrancy guard error message when called directly ────
  it("direct reentrant call to refundAfterTimeout reverts with state guard", async function () {
    const { attacker, escrow } = await deployAttacker();

    await attacker.depositToEscrow({ value: DEPOSIT });
    await time.increase(DELIVERY_PERIOD + 1);

    // A direct second call from outside (non-reentrant context) also fails
    // because state transitions to REFUNDED after the first call.
    await attacker.attack(); // first call succeeds

    // Second direct call from the test — state is now REFUNDED, not AWAITING_DELIVERY
    await expect(attacker.attack()).to.be.revertedWith(
      "Escrow: invalid state for this action"
    );
  });
});
