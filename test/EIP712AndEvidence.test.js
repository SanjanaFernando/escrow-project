const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("EIP-712 Signed Delivery Receipts & IPFS Evidence Registry", function () {
  const DEPOSIT = ethers.parseEther("3.0");
  const DELIVERY_PERIOD = 7 * 24 * 60 * 60; // 7 days
  const FEE_BPS = 200; // 2%

  async function deployFixture() {
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

  async function deployAndDeposit() {
    const ctx = await deployFixture();
    await ctx.escrow.connect(ctx.buyer).deposit({ value: DEPOSIT });
    return ctx;
  }

  // ── Helper to build EIP-712 typed data ──────────────────────────────────────
  async function createDeliveryReceiptSignature(escrow, buyerSigner, sellerAddress, amount, nonce) {
    const escrowAddress = await escrow.getAddress();
    const network = await ethers.provider.getNetwork();

    const domain = {
      name: "EscrowDeliveryVault",
      version: "1.0.0",
      chainId: network.chainId,
      verifyingContract: escrowAddress,
    };

    const types = {
      DeliveryReceipt: [
        { name: "escrowContract", type: "address" },
        { name: "seller", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "nonce", type: "uint256" },
      ],
    };

    const value = {
      escrowContract: escrowAddress,
      seller: sellerAddress,
      amount: amount,
      nonce: nonce,
    };

    const signature = await buyerSigner.signTypedData(domain, types, value);
    return { signature, domain, types, value };
  }

  // ── 1. EIP-712 Off-Chain Signed Delivery Receipts ─────────────────────────
  describe("EIP-712 Signed Delivery Receipts", function () {
    it("seller successfully claims funds using a valid off-chain buyer signature", async function () {
      const { escrow, buyer, seller } = await deployAndDeposit();

      const currentNonce = await escrow.nonces(buyer.address);
      expect(currentNonce).to.equal(0);

      // Buyer signs delivery receipt off-chain (gasless for buyer)
      const { signature } = await createDeliveryReceiptSignature(
        escrow,
        buyer,
        seller.address,
        DEPOSIT,
        currentNonce
      );

      // Seller submits the cryptographic receipt on-chain
      const claimTx = escrow.connect(seller).claimDeliveryWithSignature(signature);

      await expect(claimTx)
        .to.emit(escrow, "DeliveryConfirmed")
        .withArgs(buyer.address, seller.address, DEPOSIT);

      await expect(claimTx)
        .to.emit(escrow, "DeliveryClaimedWithSignature")
        .withArgs(buyer.address, seller.address, DEPOSIT, 0);

      await expect(claimTx).to.changeEtherBalances(
        [seller, escrow],
        [DEPOSIT, -DEPOSIT]
      );

      expect(await escrow.currentState()).to.equal(2); // COMPLETE
      expect(await escrow.amount()).to.equal(0);
      expect(await escrow.nonces(buyer.address)).to.equal(1);
    });

    it("rejects forged signature signed by someone other than the buyer", async function () {
      const { escrow, seller, stranger } = await deployAndDeposit();

      // Stranger tries to sign as buyer
      const { signature } = await createDeliveryReceiptSignature(
        escrow,
        stranger, // unauthorized signer
        seller.address,
        DEPOSIT,
        0
      );

      await expect(
        escrow.connect(seller).claimDeliveryWithSignature(signature)
      ).to.be.revertedWith("Escrow: invalid delivery signature from buyer");
    });

    it("rejects tampered amount in the signed payload", async function () {
      const { escrow, buyer, seller } = await deployAndDeposit();

      // Buyer signs for 1.0 ETH, but contract holds 3.0 ETH
      const { signature } = await createDeliveryReceiptSignature(
        escrow,
        buyer,
        seller.address,
        ethers.parseEther("1.0"), // mismatch with actual DEPOSIT (3.0 ETH)
        0
      );

      await expect(
        escrow.connect(seller).claimDeliveryWithSignature(signature)
      ).to.be.revertedWith("Escrow: invalid delivery signature from buyer");
    });

    it("prevents replay attacks: cannot reuse the same signature", async function () {
      const { escrow, buyer, seller } = await deployAndDeposit();

      const { signature } = await createDeliveryReceiptSignature(
        escrow,
        buyer,
        seller.address,
        DEPOSIT,
        0
      );

      // First claim succeeds
      await escrow.connect(seller).claimDeliveryWithSignature(signature);

      // Second claim attempt must revert (state is now COMPLETE)
      await expect(
        escrow.connect(seller).claimDeliveryWithSignature(signature)
      ).to.be.revertedWith("Escrow: invalid state for this action");
    });

    it("blocks claimDeliveryWithSignature in DISPUTED state", async function () {
      const { escrow, buyer, seller } = await deployAndDeposit();

      await escrow.connect(buyer).raiseDispute();

      const { signature } = await createDeliveryReceiptSignature(
        escrow,
        buyer,
        seller.address,
        DEPOSIT,
        0
      );

      await expect(
        escrow.connect(seller).claimDeliveryWithSignature(signature)
      ).to.be.revertedWith("Escrow: invalid state for this action");
    });
  });

  // ── 2. Decentralized IPFS Dispute Evidence Registry ───────────────────────
  describe("Decentralized IPFS Dispute Evidence Registry", function () {
    const CID_1 = "QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco";
    const DESC_1 = "Courier Proof of Delivery Receipt PDF";
    const CID_2 = "bafybeic3q5v3r3vkn6v3r3vkn6v3r3vkn6v3r3vkn6v3r3vkn6v3r3vkn6";
    const DESC_2 = "Photographic proof of damaged hardware container";

    it("allows buyer and seller to submit immutable IPFS CIDs during active dispute", async function () {
      const { escrow, buyer, seller } = await deployAndDeposit();

      await escrow.connect(buyer).raiseDispute();

      // Seller submits delivery evidence CID
      await expect(escrow.connect(seller).submitEvidence(CID_1, DESC_1))
        .to.emit(escrow, "EvidenceSubmitted")
        .withArgs(seller.address, CID_1, DESC_1, (t) => t > 0);

      expect(await escrow.getEvidenceCount()).to.equal(1);

      // Buyer submits counter-evidence CID
      await expect(escrow.connect(buyer).submitEvidence(CID_2, DESC_2))
        .to.emit(escrow, "EvidenceSubmitted")
        .withArgs(buyer.address, CID_2, DESC_2, (t) => t > 0);

      expect(await escrow.getEvidenceCount()).to.equal(2);

      // Verify stored records
      const ev0 = await escrow.getEvidence(0);
      expect(ev0.submitter).to.equal(seller.address);
      expect(ev0.ipfsCID).to.equal(CID_1);
      expect(ev0.description).to.equal(DESC_1);

      const ev1 = await escrow.getEvidence(1);
      expect(ev1.submitter).to.equal(buyer.address);
      expect(ev1.ipfsCID).to.equal(CID_2);
      expect(ev1.description).to.equal(DESC_2);
    });

    it("rejects evidence submission from an unauthorized stranger", async function () {
      const { escrow, buyer, stranger } = await deployAndDeposit();

      await escrow.connect(buyer).raiseDispute();

      await expect(
        escrow.connect(stranger).submitEvidence(CID_1, DESC_1)
      ).to.be.revertedWith("Escrow: caller is neither buyer nor seller");
    });

    it("rejects evidence submission before dispute is raised (wrong state)", async function () {
      const { escrow, buyer } = await deployAndDeposit();

      await expect(
        escrow.connect(buyer).submitEvidence(CID_1, DESC_1)
      ).to.be.revertedWith("Escrow: invalid state for this action");
    });

    it("rejects empty IPFS CID or empty description", async function () {
      const { escrow, buyer } = await deployAndDeposit();

      await escrow.connect(buyer).raiseDispute();

      await expect(
        escrow.connect(buyer).submitEvidence("", DESC_1)
      ).to.be.revertedWith("Escrow: IPFS CID cannot be empty");

      await expect(
        escrow.connect(buyer).submitEvidence(CID_1, "")
      ).to.be.revertedWith("Escrow: description cannot be empty");
    });

    it("reverts on getEvidence index out of bounds", async function () {
      const { escrow } = await deployFixture();

      await expect(
        escrow.getEvidence(0)
      ).to.be.revertedWith("Escrow: evidence index out of bounds");
    });
  });
});
