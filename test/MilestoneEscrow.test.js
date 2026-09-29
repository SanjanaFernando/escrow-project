const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("MilestoneEscrow (Multi-Stage Progressive Release)", function () {
  const FEE_BPS = 200; // 2%
  const DESCRIPTIONS = [
    "Milestone 1: Architectural Design & Wireframes",
    "Milestone 2: Core Smart Contract Development",
    "Milestone 3: Security Audit & Frontend Integration",
  ];
  const AMOUNTS = [
    ethers.parseEther("1.0"),
    ethers.parseEther("2.0"),
    ethers.parseEther("1.5"),
  ];
  const DURATIONS = [
    3 * 24 * 60 * 60, // 3 days
    7 * 24 * 60 * 60, // 7 days
    5 * 24 * 60 * 60, // 5 days
  ];
  const TOTAL_DEPOSIT = ethers.parseEther("4.5");

  async function deployMilestoneEscrowFixture() {
    const [buyer, seller, arbiter1, arbiter2, arbiter3, stranger] =
      await ethers.getSigners();

    const MilestoneEscrow = await ethers.getContractFactory("MilestoneEscrow");
    const escrow = await MilestoneEscrow.connect(buyer).deploy(
      seller.address,
      [arbiter1.address, arbiter2.address, arbiter3.address],
      FEE_BPS,
      DESCRIPTIONS,
      AMOUNTS,
      DURATIONS,
      { value: TOTAL_DEPOSIT }
    );
    await escrow.waitForDeployment();

    return { escrow, buyer, seller, arbiter1, arbiter2, arbiter3, stranger };
  }

  // ── 1. Deployment Validation ──────────────────────────────────────────────
  describe("Deployment Validation", function () {
    it("initializes parties, panel, deposit, and initial milestone correctly", async function () {
      const { escrow, buyer, seller, arbiter1, arbiter2, arbiter3 } =
        await deployMilestoneEscrowFixture();

      expect(await escrow.buyer()).to.equal(buyer.address);
      expect(await escrow.seller()).to.equal(seller.address);
      expect(await escrow.arbiterFeeBps()).to.equal(FEE_BPS);
      expect(await escrow.totalDeposit()).to.equal(TOTAL_DEPOSIT);
      expect(await escrow.currentMilestoneIndex()).to.equal(0);
      expect(await escrow.getMilestoneCount()).to.equal(3);

      expect(await escrow.isRegisteredArbiter(arbiter1.address)).to.be.true;
      expect(await escrow.isRegisteredArbiter(arbiter2.address)).to.be.true;
      expect(await escrow.isRegisteredArbiter(arbiter3.address)).to.be.true;

      const m0 = await escrow.getMilestone(0);
      expect(m0.description).to.equal(DESCRIPTIONS[0]);
      expect(m0.amount).to.equal(AMOUNTS[0]);
      expect(m0.state).to.equal(0); // PENDING
      expect(m0.deadline).to.be.gt(0);
    });

    it("rejects mismatched array lengths", async function () {
      const [buyer, seller, arb1, arb2, arb3] = await ethers.getSigners();
      const MilestoneEscrow = await ethers.getContractFactory("MilestoneEscrow");

      await expect(
        MilestoneEscrow.connect(buyer).deploy(
          seller.address,
          [arb1.address, arb2.address, arb3.address],
          FEE_BPS,
          ["Milestone 1"],
          AMOUNTS, // length 3 vs length 1
          DURATIONS,
          { value: TOTAL_DEPOSIT }
        )
      ).to.be.revertedWith("MilestoneEscrow: milestone array length mismatch");
    });

    it("rejects deposit value that does not equal sum of milestones", async function () {
      const [buyer, seller, arb1, arb2, arb3] = await ethers.getSigners();
      const MilestoneEscrow = await ethers.getContractFactory("MilestoneEscrow");

      await expect(
        MilestoneEscrow.connect(buyer).deploy(
          seller.address,
          [arb1.address, arb2.address, arb3.address],
          FEE_BPS,
          DESCRIPTIONS,
          AMOUNTS,
          DURATIONS,
          { value: ethers.parseEther("1.0") } // less than 4.5 ETH
        )
      ).to.be.revertedWith("MilestoneEscrow: deposit value must equal sum of milestones");
    });

    it("rejects buyer == seller", async function () {
      const [buyer, , arb1, arb2, arb3] = await ethers.getSigners();
      const MilestoneEscrow = await ethers.getContractFactory("MilestoneEscrow");

      await expect(
        MilestoneEscrow.connect(buyer).deploy(
          buyer.address,
          [arb1.address, arb2.address, arb3.address],
          FEE_BPS,
          DESCRIPTIONS,
          AMOUNTS,
          DURATIONS,
          { value: TOTAL_DEPOSIT }
        )
      ).to.be.revertedWith("MilestoneEscrow: buyer and seller must differ");
    });
  });

  // ── 2. Sequential Progression (Happy Path) ────────────────────────────────
  describe("Happy Path Progression", function () {
    it("allows seller to submit and buyer to approve milestone 0, releasing tranche 0", async function () {
      const { escrow, buyer, seller } = await deployMilestoneEscrowFixture();

      // Seller submits Milestone 0
      await expect(escrow.connect(seller).submitMilestone(0))
        .to.emit(escrow, "MilestoneSubmitted")
        .withArgs(0, seller.address);

      let m0 = await escrow.getMilestone(0);
      expect(m0.state).to.equal(1); // SUBMITTED

      // Buyer approves Milestone 0
      const approveTx = escrow.connect(buyer).approveMilestone(0);
      await expect(approveTx)
        .to.emit(escrow, "MilestoneApproved")
        .withArgs(0, buyer.address, AMOUNTS[0]);

      await expect(approveTx).to.changeEtherBalances(
        [seller, escrow],
        [AMOUNTS[0], -AMOUNTS[0]]
      );

      m0 = await escrow.getMilestone(0);
      expect(m0.state).to.equal(2); // APPROVED
      expect(await escrow.currentMilestoneIndex()).to.equal(1);

      // Milestone 1 deadline clock is now active
      const m1 = await escrow.getMilestone(1);
      expect(m1.deadline).to.be.gt(0);
      expect(m1.state).to.equal(0); // PENDING
    });

    it("progresses sequentially through all 3 milestones to completion", async function () {
      const { escrow, buyer, seller } = await deployMilestoneEscrowFixture();

      for (let i = 0; i < 3; i++) {
        await escrow.connect(seller).submitMilestone(i);
        await escrow.connect(buyer).approveMilestone(i);
      }

      expect(await escrow.isCompleted()).to.be.true;
      expect(await escrow.totalReleasedToSeller()).to.equal(TOTAL_DEPOSIT);
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(0);
    });
  });

  // ── 3. Dispute Resolution (2-of-3 Majority) ──────────────────────────────
  describe("Dispute Resolution on Milestone", function () {
    it("allows dispute on active milestone and resolves in favor of seller with fee deduction", async function () {
      const { escrow, buyer, seller, arbiter1, arbiter2, arbiter3 } =
        await deployMilestoneEscrowFixture();

      // Submit milestone 0
      await escrow.connect(seller).submitMilestone(0);

      // Buyer disputes milestone 0
      await expect(escrow.connect(buyer).disputeMilestone(0))
        .to.emit(escrow, "MilestoneDisputed")
        .withArgs(0, buyer.address);

      let m0 = await escrow.getMilestone(0);
      expect(m0.state).to.equal(3); // DISPUTED

      // Arbiter 1 votes for seller
      await expect(escrow.connect(arbiter1).voteMilestoneDispute(0, true))
        .to.emit(escrow, "MilestoneVoteCast")
        .withArgs(0, arbiter1.address, true, 1, 0);

      // Expected fee calculations
      const tranche = AMOUNTS[0]; // 1.0 ETH
      const totalFee = (tranche * BigInt(FEE_BPS)) / 10000n; // 0.02 ETH
      const feePerArb = totalFee / 3n;
      const dust = totalFee - feePerArb * 3n;
      const sellerPayout = tranche - totalFee + dust;

      // Arbiter 2 votes for seller -> reaches 2-of-3 majority
      const tx = escrow.connect(arbiter2).voteMilestoneDispute(0, true);

      await expect(tx)
        .to.emit(escrow, "MilestoneResolved")
        .withArgs(0, true, sellerPayout, totalFee);

      await expect(tx).to.changeEtherBalances(
        [seller, arbiter1, arbiter2, arbiter3],
        [sellerPayout, feePerArb, feePerArb, feePerArb]
      );

      m0 = await escrow.getMilestone(0);
      expect(m0.state).to.equal(2); // APPROVED
      expect(await escrow.currentMilestoneIndex()).to.equal(1);
    });

    it("resolves dispute in favor of buyer refunding the tranche minus arbiter fees", async function () {
      const { escrow, buyer, seller, arbiter1, arbiter2, arbiter3 } =
        await deployMilestoneEscrowFixture();

      await escrow.connect(seller).submitMilestone(0);
      await escrow.connect(seller).disputeMilestone(0);

      await escrow.connect(arbiter1).voteMilestoneDispute(0, false); // vote buyer

      const tranche = AMOUNTS[0];
      const totalFee = (tranche * BigInt(FEE_BPS)) / 10000n;
      const feePerArb = totalFee / 3n;
      const dust = totalFee - feePerArb * 3n;
      const buyerRefund = tranche - totalFee + dust;

      const tx = escrow.connect(arbiter3).voteMilestoneDispute(0, false);

      await expect(tx)
        .to.emit(escrow, "MilestoneResolved")
        .withArgs(0, false, buyerRefund, totalFee);

      await expect(tx).to.changeEtherBalances(
        [buyer, arbiter1, arbiter2, arbiter3],
        [buyerRefund, feePerArb, feePerArb, feePerArb]
      );

      const m0 = await escrow.getMilestone(0);
      expect(m0.state).to.equal(4); // REFUNDED
      expect(await escrow.currentMilestoneIndex()).to.equal(1);
    });
  });

  // ── 4. Timeout Refund ─────────────────────────────────────────────────────
  describe("Timeout Refund on Milestone", function () {
    it("allows buyer to reclaim tranche if seller fails to submit work before deadline", async function () {
      const { escrow, buyer } = await deployMilestoneEscrowFixture();

      // Fast-forward past Milestone 0 deadline
      await time.increase(DURATIONS[0] + 1);

      const refundTx = escrow.connect(buyer).refundMilestoneAfterTimeout(0);

      await expect(refundTx)
        .to.emit(escrow, "MilestoneRefundedAfterTimeout")
        .withArgs(0, buyer.address, AMOUNTS[0]);

      await expect(refundTx).to.changeEtherBalances(
        [buyer, escrow],
        [AMOUNTS[0], -AMOUNTS[0]]
      );

      const m0 = await escrow.getMilestone(0);
      expect(m0.state).to.equal(4); // REFUNDED
      expect(await escrow.currentMilestoneIndex()).to.equal(1);
    });

    it("rejects timeout refund before milestone deadline has passed", async function () {
      const { escrow, buyer } = await deployMilestoneEscrowFixture();

      await expect(
        escrow.connect(buyer).refundMilestoneAfterTimeout(0)
      ).to.be.revertedWith("MilestoneEscrow: milestone deadline has not passed yet");
    });
  });

  // ── 5. Access Control & State Security ────────────────────────────────────
  describe("Access Control & State Security", function () {
    it("rejects unauthorized actions from stranger", async function () {
      const { escrow, stranger } = await deployMilestoneEscrowFixture();

      await expect(
        escrow.connect(stranger).submitMilestone(0)
      ).to.be.revertedWith("MilestoneEscrow: caller is not the seller");

      await expect(
        escrow.connect(stranger).approveMilestone(0)
      ).to.be.revertedWith("MilestoneEscrow: caller is not the buyer");

      await expect(
        escrow.connect(stranger).disputeMilestone(0)
      ).to.be.revertedWith("MilestoneEscrow: caller is neither buyer nor seller");
    });

    it("prevents interacting with future milestones out of sequence", async function () {
      const { escrow, seller } = await deployMilestoneEscrowFixture();

      // Active is 0, trying to submit 1
      await expect(
        escrow.connect(seller).submitMilestone(1)
      ).to.be.revertedWith("MilestoneEscrow: milestone is not currently active");
    });

    it("prevents double voting by arbiter on the same milestone", async function () {
      const { escrow, seller, buyer, arbiter1 } =
        await deployMilestoneEscrowFixture();

      await escrow.connect(seller).submitMilestone(0);
      await escrow.connect(buyer).disputeMilestone(0);

      await escrow.connect(arbiter1).voteMilestoneDispute(0, true);

      await expect(
        escrow.connect(arbiter1).voteMilestoneDispute(0, true)
      ).to.be.revertedWith("MilestoneEscrow: arbiter has already voted on this milestone");
    });
  });
});
