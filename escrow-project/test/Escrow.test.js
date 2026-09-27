const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

describe("Escrow", function () {
  const DEPOSIT = ethers.parseEther("1.0");
  const DELIVERY_PERIOD = 7 * 24 * 60 * 60; // 7 days in seconds

  async function deployEscrowFixture() {
    const [buyer, seller, arbiter, stranger] = await ethers.getSigners();

    const Escrow = await ethers.getContractFactory("Escrow");
    const escrow = await Escrow.connect(buyer).deploy(
      seller.address,
      arbiter.address,
      DELIVERY_PERIOD
    );
    await escrow.waitForDeployment();

    return { escrow, buyer, seller, arbiter, stranger };
  }

  describe("Deployment", function () {
    it("sets the correct buyer, seller, arbiter and initial state", async function () {
      const { escrow, buyer, seller, arbiter } = await deployEscrowFixture();

      expect(await escrow.buyer()).to.equal(buyer.address);
      expect(await escrow.seller()).to.equal(seller.address);
      expect(await escrow.arbiter()).to.equal(arbiter.address);
      expect(await escrow.currentState()).to.equal(0); // AWAITING_PAYMENT
    });

    it("rejects a zero address for seller or arbiter", async function () {
      const [buyer, seller, arbiter] = await ethers.getSigners();
      const Escrow = await ethers.getContractFactory("Escrow");

      await expect(
        Escrow.connect(buyer).deploy(ethers.ZeroAddress, arbiter.address, DELIVERY_PERIOD)
      ).to.be.revertedWith("Escrow: zero address");
    });

    it("rejects buyer, seller and arbiter being the same or overlapping", async function () {
      const [buyer, seller] = await ethers.getSigners();
      const Escrow = await ethers.getContractFactory("Escrow");

      await expect(
        Escrow.connect(buyer).deploy(buyer.address, seller.address, DELIVERY_PERIOD)
      ).to.be.revertedWith("Escrow: buyer and seller must differ");
    });
  });

  describe("Deposit", function () {
    it("allows only the buyer to deposit and moves state to AWAITING_DELIVERY", async function () {
      const { escrow, buyer } = await deployEscrowFixture();

      await expect(escrow.connect(buyer).deposit({ value: DEPOSIT }))
        .to.emit(escrow, "FundsDeposited")
        .withArgs(buyer.address, DEPOSIT, anyValue);

      expect(await escrow.currentState()).to.equal(1); // AWAITING_DELIVERY
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(DEPOSIT);
    });

    it("rejects deposits from anyone other than the buyer", async function () {
      const { escrow, seller } = await deployEscrowFixture();
      await expect(
        escrow.connect(seller).deposit({ value: DEPOSIT })
      ).to.be.revertedWith("Escrow: caller is not the buyer");
    });

    it("rejects a zero-value deposit", async function () {
      const { escrow, buyer } = await deployEscrowFixture();
      await expect(
        escrow.connect(buyer).deposit({ value: 0 })
      ).to.be.revertedWith("Escrow: deposit must be greater than zero");
    });

    it("cannot be deposited into twice", async function () {
      const { escrow, buyer } = await deployEscrowFixture();
      await escrow.connect(buyer).deposit({ value: DEPOSIT });
      await expect(
        escrow.connect(buyer).deposit({ value: DEPOSIT })
      ).to.be.revertedWith("Escrow: invalid state for this action");
    });
  });

  describe("Happy path: confirmDelivery", function () {
    it("releases funds to the seller when the buyer confirms delivery", async function () {
      const { escrow, buyer, seller } = await deployEscrowFixture();
      await escrow.connect(buyer).deposit({ value: DEPOSIT });

      await expect(escrow.connect(buyer).confirmDelivery()).to.changeEtherBalances(
        [seller],
        [DEPOSIT]
      );

      expect(await escrow.currentState()).to.equal(2); // COMPLETE
    });

    it("prevents non-buyers from confirming delivery", async function () {
      const { escrow, buyer, seller, stranger } = await deployEscrowFixture();
      await escrow.connect(buyer).deposit({ value: DEPOSIT });

      await expect(escrow.connect(stranger).confirmDelivery()).to.be.revertedWith(
        "Escrow: caller is not the buyer"
      );
      await expect(escrow.connect(seller).confirmDelivery()).to.be.revertedWith(
        "Escrow: caller is not the buyer"
      );
    });
  });

  describe("Dispute path", function () {
    it("lets the buyer or seller raise a dispute while awaiting delivery", async function () {
      const { escrow, buyer, seller } = await deployEscrowFixture();
      await escrow.connect(buyer).deposit({ value: DEPOSIT });

      await expect(escrow.connect(seller).raiseDispute())
        .to.emit(escrow, "DisputeRaised")
        .withArgs(seller.address);

      expect(await escrow.currentState()).to.equal(3); // DISPUTED
    });

    it("lets the arbiter resolve the dispute in favour of the seller", async function () {
      const { escrow, buyer, seller, arbiter } = await deployEscrowFixture();
      await escrow.connect(buyer).deposit({ value: DEPOSIT });
      await escrow.connect(buyer).raiseDispute();

      await expect(
        escrow.connect(arbiter).resolveDispute(true)
      ).to.changeEtherBalances([seller], [DEPOSIT]);

      expect(await escrow.currentState()).to.equal(2); // COMPLETE
    });

    it("lets the arbiter resolve the dispute in favour of the buyer (refund)", async function () {
      const { escrow, buyer, seller, arbiter } = await deployEscrowFixture();
      await escrow.connect(buyer).deposit({ value: DEPOSIT });
      await escrow.connect(seller).raiseDispute();

      await expect(
        escrow.connect(arbiter).resolveDispute(false)
      ).to.changeEtherBalances([buyer], [DEPOSIT]);
    });

    it("rejects dispute resolution from anyone other than the arbiter", async function () {
      const { escrow, buyer, seller } = await deployEscrowFixture();
      await escrow.connect(buyer).deposit({ value: DEPOSIT });
      await escrow.connect(buyer).raiseDispute();

      await expect(
        escrow.connect(seller).resolveDispute(true)
      ).to.be.revertedWith("Escrow: caller is not the arbiter");
    });
  });

  describe("Timeout refund", function () {
    it("blocks refund before the delivery deadline", async function () {
      const { escrow, buyer } = await deployEscrowFixture();
      await escrow.connect(buyer).deposit({ value: DEPOSIT });

      await expect(escrow.connect(buyer).refundAfterTimeout()).to.be.revertedWith(
        "Escrow: delivery deadline has not passed yet"
      );
    });

    it("allows the buyer to reclaim funds once the deadline has passed", async function () {
      const { escrow, buyer } = await deployEscrowFixture();
      await escrow.connect(buyer).deposit({ value: DEPOSIT });

      await time.increase(DELIVERY_PERIOD + 1);

      await expect(escrow.connect(buyer).refundAfterTimeout()).to.changeEtherBalances(
        [buyer],
        [DEPOSIT]
      );
      expect(await escrow.currentState()).to.equal(4); // REFUNDED
    });
  });
});
