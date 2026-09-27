const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("CommitRevealEscrow (Cryptographic Secret Voting)", function () {
  const DEPOSIT = ethers.parseEther("2.0");
  const DELIVERY_PERIOD = 7 * 24 * 60 * 60; // 7 days
  const COMMIT_DURATION = 2 * 24 * 60 * 60; // 2 days
  const REVEAL_DURATION = 1 * 24 * 60 * 60; // 1 day
  const FEE_BPS = 300; // 3%

  async function deployFixture() {
    const [buyer, seller, arbiter1, arbiter2, arbiter3, stranger] =
      await ethers.getSigners();

    const Factory = await ethers.getContractFactory("CommitRevealEscrow");
    const escrow = await Factory.connect(buyer).deploy(
      seller.address,
      [arbiter1.address, arbiter2.address, arbiter3.address],
      DELIVERY_PERIOD,
      COMMIT_DURATION,
      REVEAL_DURATION,
      FEE_BPS
    );
    await escrow.waitForDeployment();

    return { escrow, buyer, seller, arbiter1, arbiter2, arbiter3, stranger };
  }

  async function deployAndDeposit() {
    const ctx = await deployFixture();
    await ctx.escrow.connect(ctx.buyer).deposit({ value: DEPOSIT });
    return ctx;
  }

  async function deployDepositAndDispute() {
    const ctx = await deployAndDeposit();
    await ctx.escrow.connect(ctx.buyer).raiseDispute();
    return ctx;
  }

  // ── 1. Deployment & Happy Path ──────────────────────────────────────────
  describe("Deployment & Happy Path", function () {
    it("initializes parties, panel, and durations correctly", async function () {
      const { escrow, buyer, seller, arbiter1, arbiter2, arbiter3 } =
        await deployFixture();

      expect(await escrow.buyer()).to.equal(buyer.address);
      expect(await escrow.seller()).to.equal(seller.address);
      expect(await escrow.commitDuration()).to.equal(COMMIT_DURATION);
      expect(await escrow.revealDuration()).to.equal(REVEAL_DURATION);
      expect(await escrow.arbiterFeeBps()).to.equal(FEE_BPS);
      expect(await escrow.isArbiter(arbiter1.address)).to.be.true;
      expect(await escrow.isArbiter(arbiter2.address)).to.be.true;
      expect(await escrow.isArbiter(arbiter3.address)).to.be.true;
    });

    it("releases full funds to seller on delivery confirmation", async function () {
      const { escrow, buyer, seller } = await deployAndDeposit();

      const tx = escrow.connect(buyer).confirmDelivery();
      await expect(tx)
        .to.emit(escrow, "DeliveryConfirmed")
        .withArgs(buyer.address, seller.address, DEPOSIT);

      await expect(tx).to.changeEtherBalances(
        [seller, escrow],
        [DEPOSIT, -DEPOSIT]
      );

      expect(await escrow.currentState()).to.equal(2); // COMPLETE
    });
  });

  // ── 2. Cryptographic Commit Phase ───────────────────────────────────────
  describe("Commit Phase Mechanics", function () {
    it("allows registered arbiters to commit sealed hashes and transitions to reveal when all 3 commit", async function () {
      const { escrow, arbiter1, arbiter2, arbiter3 } =
        await deployDepositAndDispute();

      expect(await escrow.currentState()).to.equal(3); // DISPUTED_COMMIT

      // Generate secret salt and commitments for arbiters
      const salt1 = ethers.randomBytes(32);
      const commit1 = await escrow.generateCommitmentHash(true, salt1, arbiter1.address);

      const salt2 = ethers.randomBytes(32);
      const commit2 = await escrow.generateCommitmentHash(true, salt2, arbiter2.address);

      const salt3 = ethers.randomBytes(32);
      const commit3 = await escrow.generateCommitmentHash(false, salt3, arbiter3.address);

      // Arbiter 1 commits
      await expect(escrow.connect(arbiter1).commitVote(commit1))
        .to.emit(escrow, "VoteCommitted")
        .withArgs(arbiter1.address);

      expect(await escrow.currentState()).to.equal(3); // still DISPUTED_COMMIT

      // Arbiter 2 commits
      await escrow.connect(arbiter2).commitVote(commit2);
      expect(await escrow.currentState()).to.equal(3);

      // Arbiter 3 commits -> all 3 committed triggers automated transition to DISPUTED_REVEAL
      await expect(escrow.connect(arbiter3).commitVote(commit3))
        .to.emit(escrow, "RevealPhaseStarted");

      expect(await escrow.currentState()).to.equal(4); // DISPUTED_REVEAL
    });

    it("prevents double committing by the same arbiter", async function () {
      const { escrow, arbiter1 } = await deployDepositAndDispute();
      const salt = ethers.randomBytes(32);
      const commitment = await escrow.generateCommitmentHash(true, salt, arbiter1.address);

      await escrow.connect(arbiter1).commitVote(commitment);

      await expect(
        escrow.connect(arbiter1).commitVote(commitment)
      ).to.be.revertedWith("CommitRevealEscrow: arbiter has already committed");
    });

    it("rejects unauthorized commitment from stranger", async function () {
      const { escrow, stranger } = await deployDepositAndDispute();
      const salt = ethers.randomBytes(32);
      const commitment = await escrow.generateCommitmentHash(true, salt, stranger.address);

      await expect(
        escrow.connect(stranger).commitVote(commitment)
      ).to.be.revertedWith("CommitRevealEscrow: caller is not a registered arbiter");
    });
  });

  // ── 3. Cryptographic Reveal Phase & Quorum ───────────────────────────────
  describe("Reveal Phase & Cryptographic Preimage Verification", function () {
    it("authenticates true vote/salt, resolves 2-of-3 dispute, and distributes fee", async function () {
      const { escrow, seller, arbiter1, arbiter2, arbiter3 } =
        await deployDepositAndDispute();

      // Salts and commitments
      const salt1 = ethers.randomBytes(32);
      const commit1 = await escrow.generateCommitmentHash(true, salt1, arbiter1.address);

      const salt2 = ethers.randomBytes(32);
      const commit2 = await escrow.generateCommitmentHash(true, salt2, arbiter2.address);

      const salt3 = ethers.randomBytes(32);
      const commit3 = await escrow.generateCommitmentHash(false, salt3, arbiter3.address);

      // Submit all 3 commitments
      await escrow.connect(arbiter1).commitVote(commit1);
      await escrow.connect(arbiter2).commitVote(commit2);
      await escrow.connect(arbiter3).commitVote(commit3); // triggers DISPUTED_REVEAL

      // Arbiter 1 reveals vote (true for seller)
      await expect(escrow.connect(arbiter1).revealVote(true, salt1))
        .to.emit(escrow, "VoteRevealed")
        .withArgs(arbiter1.address, true);

      expect(await escrow.votesForSeller()).to.equal(1);
      expect(await escrow.currentState()).to.equal(4); // still in DISPUTED_REVEAL

      // Fee calculations for 3% fee on 2 ETH
      const totalFee = (DEPOSIT * BigInt(FEE_BPS)) / 10000n; // 0.06 ETH
      const feePerArb = totalFee / 3n; // 0.02 ETH each
      const dust = totalFee - feePerArb * 3n;
      const sellerPayout = DEPOSIT - totalFee + dust;

      // Arbiter 2 reveals vote (true for seller) -> reaches 2-of-3 majority!
      const revealTx = escrow.connect(arbiter2).revealVote(true, salt2);

      await expect(revealTx)
        .to.emit(escrow, "DisputeResolved")
        .withArgs(true, sellerPayout, totalFee);

      await expect(revealTx).to.changeEtherBalances(
        [seller, arbiter1, arbiter2, arbiter3],
        [sellerPayout, feePerArb, feePerArb, feePerArb]
      );

      expect(await escrow.currentState()).to.equal(2); // COMPLETE
      expect(await escrow.amount()).to.equal(0);
    });

    it("rejects invalid reveal if arbiter flips vote or uses wrong salt", async function () {
      const { escrow, arbiter1, arbiter2, arbiter3 } =
        await deployDepositAndDispute();

      const salt1 = ethers.randomBytes(32);
      const commit1 = await escrow.generateCommitmentHash(true, salt1, arbiter1.address);

      await escrow.connect(arbiter1).commitVote(commit1);
      await escrow.connect(arbiter2).commitVote(commit1); // using random commit
      await escrow.connect(arbiter3).commitVote(commit1); // transitions to DISPUTED_REVEAL

      // Arbiter 1 attempts to reveal with false (vote flipped)
      await expect(
        escrow.connect(arbiter1).revealVote(false, salt1)
      ).to.be.revertedWith("CommitRevealEscrow: hash mismatch - invalid reveal");

      // Arbiter 1 attempts to reveal with wrong salt
      const wrongSalt = ethers.randomBytes(32);
      await expect(
        escrow.connect(arbiter1).revealVote(true, wrongSalt)
      ).to.be.revertedWith("CommitRevealEscrow: hash mismatch - invalid reveal");
    });
  });

  // ── 4. Inactive Arbiter Deadlock Defense (Failsafe) ──────────────────────
  describe("Deadlock Failsafe", function () {
    it("refunds buyer if arbiters abandon the reveal phase past reveal deadline", async function () {
      const { escrow, buyer, arbiter1 } = await deployDepositAndDispute();

      const salt = ethers.randomBytes(32);
      const commit = await escrow.generateCommitmentHash(true, salt, arbiter1.address);
      await escrow.connect(arbiter1).commitVote(commit);

      // Fast forward past commit deadline
      await time.increase(COMMIT_DURATION + 1);

      // Start reveal phase manually
      await escrow.startRevealPhase();

      // Fast forward past reveal deadline without other arbiters revealing
      await time.increase(REVEAL_DURATION + 1);

      // Call handleRevealTimeout to recover funds
      const refundTx = escrow.handleRevealTimeout();

      await expect(refundTx).to.changeEtherBalances(
        [buyer, escrow],
        [DEPOSIT, -DEPOSIT]
      );

      expect(await escrow.currentState()).to.equal(5); // REFUNDED (5)
    });
  });
});
