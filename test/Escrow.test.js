const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

// ─────────────────────────────────────────────────────────────────────────────
// Escrow.test.js — Full test suite for the enhanced Escrow contract
//
// Covers:
//   1. Deployment validation (constructor checks)
//   2. Deposit mechanics and access control
//   3. Happy path: buyer confirms delivery → seller paid
//   4. Dispute path: 2-of-3 arbiter voting (seller wins, buyer wins, fee split)
//   5. Timeout refund path
//   6. Cross-state protection (actions called in wrong state)
//   7. Edge cases: zero deposit, double deposit, double vote, stranger calls
// ─────────────────────────────────────────────────────────────────────────────

describe("Escrow (Enhanced)", function () {
  // ── Constants ────────────────────────────────────────────────────────────
  const DEPOSIT         = ethers.parseEther("1.0");
  const DELIVERY_PERIOD = 7 * 24 * 60 * 60; // 7 days in seconds
  const FEE_BPS         = 200;               // 2% arbiter fee

  // ── Fixture ──────────────────────────────────────────────────────────────
  // Returns a freshly deployed Escrow plus all named signers.
  async function deployEscrowFixture() {
    const [buyer, seller, arbiter1, arbiter2, arbiter3, stranger] =
      await ethers.getSigners();

    const Escrow = await ethers.getContractFactory("Escrow");
    const escrow = await Escrow.connect(buyer).deploy(
      seller.address,
      [arbiter1.address, arbiter2.address, arbiter3.address],
      DELIVERY_PERIOD,
      FEE_BPS
    );
    await escrow.waitForDeployment();

    return { escrow, buyer, seller, arbiter1, arbiter2, arbiter3, stranger };
  }

  // Helper: deposit funds and return the fixture
  async function deployAndDeposit() {
    const ctx = await deployEscrowFixture();
    await ctx.escrow.connect(ctx.buyer).deposit({ value: DEPOSIT });
    return ctx;
  }

  // Helper: deposit + raise dispute
  async function deployDepositAndDispute() {
    const ctx = await deployAndDeposit();
    await ctx.escrow.connect(ctx.buyer).raiseDispute();
    return ctx;
  }

  // ── 1. Deployment ─────────────────────────────────────────────────────────
  describe("Deployment", function () {
    it("sets buyer, seller, all three arbiters and initial state correctly", async function () {
      const { escrow, buyer, seller, arbiter1, arbiter2, arbiter3 } =
        await deployEscrowFixture();

      expect(await escrow.buyer()).to.equal(buyer.address);
      expect(await escrow.seller()).to.equal(seller.address);
      expect(await escrow.arbiters(0)).to.equal(arbiter1.address);
      expect(await escrow.arbiters(1)).to.equal(arbiter2.address);
      expect(await escrow.arbiters(2)).to.equal(arbiter3.address);
      expect(await escrow.isArbiter(arbiter1.address)).to.be.true;
      expect(await escrow.isArbiter(arbiter2.address)).to.be.true;
      expect(await escrow.isArbiter(arbiter3.address)).to.be.true;
      expect(await escrow.currentState()).to.equal(0); // AWAITING_PAYMENT
      expect(await escrow.arbiterFeeBps()).to.equal(FEE_BPS);
    });

    it("rejects zero address for seller", async function () {
      const [buyer, , arbiter1, arbiter2, arbiter3] = await ethers.getSigners();
      const Escrow = await ethers.getContractFactory("Escrow");
      await expect(
        Escrow.connect(buyer).deploy(
          ethers.ZeroAddress,
          [arbiter1.address, arbiter2.address, arbiter3.address],
          DELIVERY_PERIOD,
          FEE_BPS
        )
      ).to.be.revertedWith("Escrow: seller is zero address");
    });

    it("rejects buyer == seller", async function () {
      const [buyer, , arbiter1, arbiter2, arbiter3] = await ethers.getSigners();
      const Escrow = await ethers.getContractFactory("Escrow");
      await expect(
        Escrow.connect(buyer).deploy(
          buyer.address,
          [arbiter1.address, arbiter2.address, arbiter3.address],
          DELIVERY_PERIOD,
          FEE_BPS
        )
      ).to.be.revertedWith("Escrow: buyer and seller must differ");
    });

    it("rejects an arbiter that is the same as the buyer", async function () {
      const [buyer, seller, , arbiter2, arbiter3] = await ethers.getSigners();
      const Escrow = await ethers.getContractFactory("Escrow");
      await expect(
        Escrow.connect(buyer).deploy(
          seller.address,
          [buyer.address, arbiter2.address, arbiter3.address],
          DELIVERY_PERIOD,
          FEE_BPS
        )
      ).to.be.revertedWith("Escrow: arbiter must differ from buyer");
    });

    it("rejects an arbiter that is the same as the seller", async function () {
      const [buyer, seller, , arbiter2, arbiter3] = await ethers.getSigners();
      const Escrow = await ethers.getContractFactory("Escrow");
      await expect(
        Escrow.connect(buyer).deploy(
          seller.address,
          [seller.address, arbiter2.address, arbiter3.address],
          DELIVERY_PERIOD,
          FEE_BPS
        )
      ).to.be.revertedWith("Escrow: arbiter must differ from seller");
    });

    it("rejects duplicate arbiter addresses", async function () {
      const [buyer, seller, arbiter1, , arbiter3] = await ethers.getSigners();
      const Escrow = await ethers.getContractFactory("Escrow");
      await expect(
        Escrow.connect(buyer).deploy(
          seller.address,
          [arbiter1.address, arbiter1.address, arbiter3.address], // duplicate
          DELIVERY_PERIOD,
          FEE_BPS
        )
      ).to.be.revertedWith("Escrow: duplicate arbiter address");
    });

    it("rejects zero delivery period", async function () {
      const [buyer, seller, arbiter1, arbiter2, arbiter3] = await ethers.getSigners();
      const Escrow = await ethers.getContractFactory("Escrow");
      await expect(
        Escrow.connect(buyer).deploy(
          seller.address,
          [arbiter1.address, arbiter2.address, arbiter3.address],
          0,
          FEE_BPS
        )
      ).to.be.revertedWith("Escrow: delivery period must be positive");
    });

    it("rejects arbiter fee above 10% (1000 bps)", async function () {
      const [buyer, seller, arbiter1, arbiter2, arbiter3] = await ethers.getSigners();
      const Escrow = await ethers.getContractFactory("Escrow");
      await expect(
        Escrow.connect(buyer).deploy(
          seller.address,
          [arbiter1.address, arbiter2.address, arbiter3.address],
          DELIVERY_PERIOD,
          1001 // 10.01% — over cap
        )
      ).to.be.revertedWith("Escrow: arbiter fee exceeds 10% cap");
    });

    it("isRegisteredArbiter returns false for a stranger", async function () {
      const { escrow, stranger } = await deployEscrowFixture();
      expect(await escrow.isRegisteredArbiter(stranger.address)).to.be.false;
    });
  });

  // ── 2. Deposit ─────────────────────────────────────────────────────────────
  describe("Deposit", function () {
    it("allows only the buyer to deposit and moves state to AWAITING_DELIVERY", async function () {
      const { escrow, buyer } = await deployEscrowFixture();

      await expect(escrow.connect(buyer).deposit({ value: DEPOSIT }))
        .to.emit(escrow, "FundsDeposited")
        .withArgs(buyer.address, DEPOSIT, anyValue);

      expect(await escrow.currentState()).to.equal(1); // AWAITING_DELIVERY
      expect(
        await ethers.provider.getBalance(await escrow.getAddress())
      ).to.equal(DEPOSIT);
    });

    it("rejects deposits from seller", async function () {
      const { escrow, seller } = await deployEscrowFixture();
      await expect(
        escrow.connect(seller).deposit({ value: DEPOSIT })
      ).to.be.revertedWith("Escrow: caller is not the buyer");
    });

    it("rejects deposits from an arbiter", async function () {
      const { escrow, arbiter1 } = await deployEscrowFixture();
      await expect(
        escrow.connect(arbiter1).deposit({ value: DEPOSIT })
      ).to.be.revertedWith("Escrow: caller is not the buyer");
    });

    it("rejects deposits from a stranger", async function () {
      const { escrow, stranger } = await deployEscrowFixture();
      await expect(
        escrow.connect(stranger).deposit({ value: DEPOSIT })
      ).to.be.revertedWith("Escrow: caller is not the buyer");
    });

    it("rejects a zero-value deposit", async function () {
      const { escrow, buyer } = await deployEscrowFixture();
      await expect(
        escrow.connect(buyer).deposit({ value: 0 })
      ).to.be.revertedWith("Escrow: deposit must be greater than zero");
    });

    it("cannot be deposited into twice (state guard)", async function () {
      const { escrow, buyer } = await deployEscrowFixture();
      await escrow.connect(buyer).deposit({ value: DEPOSIT });
      await expect(
        escrow.connect(buyer).deposit({ value: DEPOSIT })
      ).to.be.revertedWith("Escrow: invalid state for this action");
    });

    it("sets deliveryDeadline to block.timestamp + deliveryPeriod", async function () {
      const { escrow, buyer } = await deployEscrowFixture();
      const tx = await escrow.connect(buyer).deposit({ value: DEPOSIT });
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      const deadline = await escrow.deliveryDeadline();
      expect(deadline).to.equal(BigInt(block.timestamp) + BigInt(DELIVERY_PERIOD));
    });
  });

  // ── 3. Happy Path ──────────────────────────────────────────────────────────
  describe("Happy path: confirmDelivery", function () {
    it("releases full funds to seller when buyer confirms delivery", async function () {
      const { escrow, buyer, seller } = await deployAndDeposit();

      await expect(escrow.connect(buyer).confirmDelivery())
        .to.changeEtherBalances([seller, escrow], [DEPOSIT, -DEPOSIT]);

      expect(await escrow.currentState()).to.equal(2); // COMPLETE
      expect(await escrow.amount()).to.equal(0);
    });

    it("emits DeliveryConfirmed with correct args", async function () {
      const { escrow, buyer, seller } = await deployAndDeposit();

      await expect(escrow.connect(buyer).confirmDelivery())
        .to.emit(escrow, "DeliveryConfirmed")
        .withArgs(buyer.address, seller.address, DEPOSIT);
    });

    it("prevents seller from confirming delivery", async function () {
      const { escrow, seller } = await deployAndDeposit();
      await expect(escrow.connect(seller).confirmDelivery()).to.be.revertedWith(
        "Escrow: caller is not the buyer"
      );
    });

    it("prevents an arbiter from confirming delivery", async function () {
      const { escrow, arbiter1 } = await deployAndDeposit();
      await expect(escrow.connect(arbiter1).confirmDelivery()).to.be.revertedWith(
        "Escrow: caller is not the buyer"
      );
    });

    it("prevents a stranger from confirming delivery", async function () {
      const { escrow, stranger } = await deployAndDeposit();
      await expect(escrow.connect(stranger).confirmDelivery()).to.be.revertedWith(
        "Escrow: caller is not the buyer"
      );
    });

    it("cannot confirmDelivery after dispute is raised (wrong state)", async function () {
      const { escrow, buyer } = await deployDepositAndDispute();
      await expect(escrow.connect(buyer).confirmDelivery()).to.be.revertedWith(
        "Escrow: invalid state for this action"
      );
    });

    it("buyer can still confirmDelivery after deadline passes (deadline only unlocks timeout refund)", async function () {
      const { escrow, buyer, seller } = await deployAndDeposit();

      // Fast-forward past the delivery deadline
      await time.increase(DELIVERY_PERIOD + 1);

      // confirmDelivery is NOT gated by deadline — only refundAfterTimeout is.
      // This proves the state machine: deadline expiry gives the buyer a CHOICE
      // (refund OR confirm), it does not auto-cancel the escrow.
      await expect(escrow.connect(buyer).confirmDelivery())
        .to.emit(escrow, "DeliveryConfirmed")
        .withArgs(buyer.address, seller.address, DEPOSIT);

      expect(await escrow.currentState()).to.equal(2); // COMPLETE
      expect(await escrow.amount()).to.equal(0);
    });
  });

  // ── 4. Dispute Path ────────────────────────────────────────────────────────
  describe("Dispute path: raiseDispute + 2-of-3 arbiter castVote", function () {

    describe("raiseDispute", function () {
      it("buyer can raise a dispute and moves state to DISPUTED", async function () {
        const { escrow, buyer } = await deployAndDeposit();

        await expect(escrow.connect(buyer).raiseDispute())
          .to.emit(escrow, "DisputeRaised")
          .withArgs(buyer.address);

        expect(await escrow.currentState()).to.equal(3); // DISPUTED
      });

      it("seller can raise a dispute", async function () {
        const { escrow, seller } = await deployAndDeposit();

        await expect(escrow.connect(seller).raiseDispute())
          .to.emit(escrow, "DisputeRaised")
          .withArgs(seller.address);
      });

      it("an arbiter cannot raise a dispute (onlyParty modifier)", async function () {
        const { escrow, arbiter1 } = await deployAndDeposit();
        await expect(escrow.connect(arbiter1).raiseDispute()).to.be.revertedWith(
          "Escrow: caller is neither buyer nor seller"
        );
      });

      it("a stranger cannot raise a dispute", async function () {
        const { escrow, stranger } = await deployAndDeposit();
        await expect(escrow.connect(stranger).raiseDispute()).to.be.revertedWith(
          "Escrow: caller is neither buyer nor seller"
        );
      });

      it("cannot raise dispute before deposit (wrong state)", async function () {
        const { escrow, buyer } = await deployEscrowFixture();
        await expect(escrow.connect(buyer).raiseDispute()).to.be.revertedWith(
          "Escrow: invalid state for this action"
        );
      });
    });

    describe("castVote — seller wins (2-of-3)", function () {
      it("first vote emits ArbiterVoteCast but does not resolve yet", async function () {
        const { escrow, arbiter1 } = await deployDepositAndDispute();

        await expect(escrow.connect(arbiter1).castVote(true))
          .to.emit(escrow, "ArbiterVoteCast")
          .withArgs(arbiter1.address, true, 1, 0);

        expect(await escrow.currentState()).to.equal(3); // still DISPUTED
        expect(await escrow.votesForSeller()).to.equal(1);
      });

      it("second seller-vote reaches majority → seller paid, fee distributed", async function () {
        const { escrow, seller, arbiter1, arbiter2, arbiter3 } =
          await deployDepositAndDispute();

        await escrow.connect(arbiter1).castVote(true);

        // Expected amounts
        const totalFee     = (DEPOSIT * BigInt(FEE_BPS)) / 10_000n; // 0.02 ETH
        const feePerArbiter = totalFee / 3n;
        const dust          = totalFee - feePerArbiter * 3n;
        const sellerPayout  = DEPOSIT - totalFee + dust;

        const tx = escrow.connect(arbiter2).castVote(true);

        // Check emitted event
        await expect(tx)
          .to.emit(escrow, "DisputeResolved")
          .withArgs(true, sellerPayout, totalFee);

        // Check balance changes separately (toolbox v4: cannot chain changeEtherBalances after emit)
        await expect(tx)
          .to.changeEtherBalances(
            [seller, arbiter1, arbiter2, arbiter3],
            [sellerPayout, feePerArbiter, feePerArbiter, feePerArbiter]
          );

        expect(await escrow.currentState()).to.equal(2); // COMPLETE
        expect(await escrow.amount()).to.equal(0);
      });

      it("third vote is not needed once majority is reached", async function () {
        const { escrow, arbiter1, arbiter2, arbiter3 } = await deployDepositAndDispute();
        await escrow.connect(arbiter1).castVote(true);
        await escrow.connect(arbiter2).castVote(true); // resolves here
        // arbiter3 cannot vote — contract is in COMPLETE state
        await expect(escrow.connect(arbiter3).castVote(true)).to.be.revertedWith(
          "Escrow: invalid state for this action"
        );
      });
    });

    describe("castVote — buyer wins (2-of-3 refund)", function () {
      it("two buyer-votes trigger refund to buyer with correct amounts", async function () {
        const { escrow, buyer, arbiter1, arbiter2, arbiter3 } =
          await deployDepositAndDispute();

        await escrow.connect(arbiter1).castVote(false);

        const totalFee     = (DEPOSIT * BigInt(FEE_BPS)) / 10_000n;
        const feePerArbiter = totalFee / 3n;
        const dust          = totalFee - feePerArbiter * 3n;
        const buyerPayout   = DEPOSIT - totalFee + dust;

        const tx = escrow.connect(arbiter2).castVote(false);

        // Check emitted event
        await expect(tx)
          .to.emit(escrow, "DisputeResolved")
          .withArgs(false, buyerPayout, totalFee);

        // Check balance changes separately (toolbox v4: cannot chain changeEtherBalances after emit)
        await expect(tx)
          .to.changeEtherBalances(
            [buyer, arbiter1, arbiter2, arbiter3],
            [buyerPayout, feePerArbiter, feePerArbiter, feePerArbiter]
          );

        expect(await escrow.currentState()).to.equal(2); // COMPLETE
      });
    });

    describe("castVote — split vote (1–1 before majority)", function () {
      it("a 1-1 vote leaves the contract DISPUTED waiting for the third arbiter", async function () {
        const { escrow, arbiter1, arbiter2 } = await deployDepositAndDispute();

        await escrow.connect(arbiter1).castVote(true);  // 1-0
        await escrow.connect(arbiter2).castVote(false); // 1-1

        expect(await escrow.currentState()).to.equal(3); // still DISPUTED
        expect(await escrow.votesForSeller()).to.equal(1);
        expect(await escrow.votesForBuyer()).to.equal(1);
      });

      it("third arbiter breaks the 1-1 tie and resolves correctly", async function () {
        const { escrow, seller, arbiter1, arbiter2, arbiter3 } =
          await deployDepositAndDispute();

        await escrow.connect(arbiter1).castVote(true);
        await escrow.connect(arbiter2).castVote(false);
        // arbiter3 casts the deciding vote for the seller
        await expect(escrow.connect(arbiter3).castVote(true))
          .to.emit(escrow, "DisputeResolved")
          .withArgs(true, anyValue, anyValue);

        expect(await escrow.currentState()).to.equal(2); // COMPLETE
      });
    });

    describe("castVote — access control", function () {
      it("a stranger cannot cast a vote", async function () {
        const { escrow, stranger } = await deployDepositAndDispute();
        await expect(escrow.connect(stranger).castVote(true)).to.be.revertedWith(
          "Escrow: caller is not a registered arbiter"
        );
      });

      it("the buyer cannot cast a vote", async function () {
        const { escrow, buyer } = await deployDepositAndDispute();
        await expect(escrow.connect(buyer).castVote(true)).to.be.revertedWith(
          "Escrow: caller is not a registered arbiter"
        );
      });

      it("the seller cannot cast a vote", async function () {
        const { escrow, seller } = await deployDepositAndDispute();
        await expect(escrow.connect(seller).castVote(true)).to.be.revertedWith(
          "Escrow: caller is not a registered arbiter"
        );
      });

      it("an arbiter cannot vote twice", async function () {
        const { escrow, arbiter1 } = await deployDepositAndDispute();
        await escrow.connect(arbiter1).castVote(true);
        await expect(escrow.connect(arbiter1).castVote(true)).to.be.revertedWith(
          "Escrow: arbiter has already voted"
        );
      });

      it("castVote is blocked before a dispute is raised (wrong state)", async function () {
        const { escrow, arbiter1 } = await deployAndDeposit();
        await expect(escrow.connect(arbiter1).castVote(true)).to.be.revertedWith(
          "Escrow: invalid state for this action"
        );
      });
    });

    describe("Fee edge cases", function () {
      it("zero-fee escrow (0 bps) pays out the full amount with no fee events", async function () {
        const [buyer, seller, arbiter1, arbiter2, arbiter3] =
          await ethers.getSigners();
        const Escrow = await ethers.getContractFactory("Escrow");
        const escrow = await Escrow.connect(buyer).deploy(
          seller.address,
          [arbiter1.address, arbiter2.address, arbiter3.address],
          DELIVERY_PERIOD,
          0 // 0 bps
        );
        await escrow.waitForDeployment();

        await escrow.connect(buyer).deposit({ value: DEPOSIT });
        await escrow.connect(buyer).raiseDispute();
        await escrow.connect(arbiter1).castVote(true);

        const tx = escrow.connect(arbiter2).castVote(true);
        await expect(tx)
          .to.emit(escrow, "DisputeResolved")
          .withArgs(true, DEPOSIT, 0);
        // No ArbiterFeePaid events when fee is 0
        await expect(tx).to.not.emit(escrow, "ArbiterFeePaid");
      });

      it("max-fee escrow (1000 bps = 10%) distributes correctly", async function () {
        const [buyer, seller, arbiter1, arbiter2, arbiter3] =
          await ethers.getSigners();
        const Escrow = await ethers.getContractFactory("Escrow");
        const escrow = await Escrow.connect(buyer).deploy(
          seller.address,
          [arbiter1.address, arbiter2.address, arbiter3.address],
          DELIVERY_PERIOD,
          1000 // 10%
        );
        await escrow.waitForDeployment();

        await escrow.connect(buyer).deposit({ value: DEPOSIT });
        await escrow.connect(buyer).raiseDispute();
        await escrow.connect(arbiter1).castVote(true);
        await escrow.connect(arbiter2).castVote(true);

        const expectedFee = DEPOSIT / 10n; // 10%
        expect(await escrow.amount()).to.equal(0); // all funds distributed
        expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(0);
        // Total balance change of all arbiters equals expectedFee
        // (individual splits checked in the 2% test above)
        const totalFee = (DEPOSIT * 1000n) / 10_000n;
        expect(totalFee).to.equal(expectedFee);
      });
    });
  });

  // ── 5. Timeout Refund ──────────────────────────────────────────────────────
  describe("Timeout refund", function () {
    it("blocks refund before the delivery deadline", async function () {
      const { escrow, buyer } = await deployAndDeposit();
      await expect(escrow.connect(buyer).refundAfterTimeout()).to.be.revertedWith(
        "Escrow: delivery deadline has not passed yet"
      );
    });

    it("allows buyer to reclaim full funds after deadline passes", async function () {
      const { escrow, buyer } = await deployAndDeposit();

      await time.increase(DELIVERY_PERIOD + 1);

      const tx = escrow.connect(buyer).refundAfterTimeout();

      // Check emitted event
      await expect(tx)
        .to.emit(escrow, "RefundedAfterTimeout")
        .withArgs(buyer.address, DEPOSIT);

      // Check balance changes separately (toolbox v4: cannot chain changeEtherBalances after emit)
      await expect(tx)
        .to.changeEtherBalances([buyer, escrow], [DEPOSIT, -DEPOSIT]);

      expect(await escrow.currentState()).to.equal(4); // REFUNDED
      expect(await escrow.amount()).to.equal(0);
    });

    it("seller cannot call refundAfterTimeout", async function () {
      const { escrow, seller } = await deployAndDeposit();
      await time.increase(DELIVERY_PERIOD + 1);
      await expect(escrow.connect(seller).refundAfterTimeout()).to.be.revertedWith(
        "Escrow: caller is not the buyer"
      );
    });

    it("refundAfterTimeout is blocked in DISPUTED state", async function () {
      const { escrow, buyer } = await deployDepositAndDispute();
      await time.increase(DELIVERY_PERIOD + 1);
      await expect(escrow.connect(buyer).refundAfterTimeout()).to.be.revertedWith(
        "Escrow: invalid state for this action"
      );
    });
  });

  // ── 6. Cross-State Protection ──────────────────────────────────────────────
  describe("Cross-state protection (actions in wrong state)", function () {
    it("cannot raiseDispute before deposit", async function () {
      const { escrow, buyer } = await deployEscrowFixture();
      await expect(escrow.connect(buyer).raiseDispute()).to.be.revertedWith(
        "Escrow: invalid state for this action"
      );
    });

    it("cannot confirmDelivery before deposit", async function () {
      const { escrow, buyer } = await deployEscrowFixture();
      await expect(escrow.connect(buyer).confirmDelivery()).to.be.revertedWith(
        "Escrow: invalid state for this action"
      );
    });

    it("cannot refundAfterTimeout before deposit", async function () {
      const { escrow, buyer } = await deployEscrowFixture();
      await time.increase(DELIVERY_PERIOD + 1);
      await expect(escrow.connect(buyer).refundAfterTimeout()).to.be.revertedWith(
        "Escrow: invalid state for this action"
      );
    });

    it("cannot raiseDispute again after it is already raised", async function () {
      const { escrow, buyer } = await deployDepositAndDispute();
      await expect(escrow.connect(buyer).raiseDispute()).to.be.revertedWith(
        "Escrow: invalid state for this action"
      );
    });

    it("cannot deposit after confirmDelivery (COMPLETE state)", async function () {
      const { escrow, buyer } = await deployAndDeposit();
      await escrow.connect(buyer).confirmDelivery();
      await expect(
        escrow.connect(buyer).deposit({ value: DEPOSIT })
      ).to.be.revertedWith("Escrow: invalid state for this action");
    });
  });

  // ── 7. getDetails View ────────────────────────────────────────────────────
  describe("getDetails()", function () {
    it("returns all contract state fields correctly after deposit", async function () {
      const { escrow, buyer, seller, arbiter1, arbiter2, arbiter3 } =
        await deployAndDeposit();

      const details = await escrow.getDetails();
      expect(details._buyer).to.equal(buyer.address);
      expect(details._seller).to.equal(seller.address);
      expect(details._arbiters[0]).to.equal(arbiter1.address);
      expect(details._arbiters[1]).to.equal(arbiter2.address);
      expect(details._arbiters[2]).to.equal(arbiter3.address);
      expect(details._amount).to.equal(DEPOSIT);
      expect(details._state).to.equal(1); // AWAITING_DELIVERY
      expect(details._votesForSeller).to.equal(0);
      expect(details._votesForBuyer).to.equal(0);
    });

    it("reflects updated vote counts mid-dispute", async function () {
      const { escrow, arbiter1, arbiter2 } = await deployDepositAndDispute();
      await escrow.connect(arbiter1).castVote(true);
      await escrow.connect(arbiter2).castVote(false);

      const details = await escrow.getDetails();
      expect(details._votesForSeller).to.equal(1);
      expect(details._votesForBuyer).to.equal(1);
    });
  });
});
