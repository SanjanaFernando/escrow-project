// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title  Commit-Reveal Secret Voting Escrow
/// @author EC8204 Group Project, University of Ruhuna
/// @notice Implements a two-phase cryptographic Commit-Reveal voting scheme for the 3-arbiter panel.
///         Protects against mempool front-running (MEV), arbiter bribery, and herd-mentality copying.
///
/// @dev    Security Design:
///         - Commit Phase: Arbiters submit H = keccak256(vote, salt, arbiterAddress).
///           Binding the commitment to msg.sender prevents commitment-copying / replay attacks.
///         - Reveal Phase: Arbiters disclose (vote, salt) on-chain for preimage verification.
///         - Strict Checks-Effects-Interactions (CEI) pattern on all payouts.
///         - OpenZeppelin ReentrancyGuard defense on state transitions.
///         - Failsafe timeout mechanism prevents locked funds if arbiters refuse to reveal.
contract CommitRevealEscrow is ReentrancyGuard {

    // ─── State Machine ────────────────────────────────────────────────────────

    enum State {
        AWAITING_PAYMENT,   // 0: Deployed; awaiting buyer deposit
        AWAITING_DELIVERY,  // 1: Funds locked; awaiting seller delivery
        COMPLETE,           // 2: Funds paid out (to seller or buyer via resolution)
        DISPUTED_COMMIT,    // 3: Dispute raised; arbiters submitting sealed commitment hashes
        DISPUTED_REVEAL,    // 4: Commit phase ended; arbiters revealing votes and salts
        REFUNDED            // 5: Buyer refunded via timeout
    }

    // ─── Parties ──────────────────────────────────────────────────────────────

    address payable public immutable buyer;
    address payable public immutable seller;

    uint8 public constant ARBITER_COUNT = 3;
    address[3] public arbiters;
    mapping(address => bool) public isArbiter;

    // ─── Commit-Reveal State ──────────────────────────────────────────────────

    mapping(address => bytes32) public voteCommitments;
    mapping(address => bool) public hasCommitted;
    mapping(address => bool) public hasRevealed;

    uint8 public commitCount;
    uint8 public votesForSeller;
    uint8 public votesForBuyer;

    uint256 public immutable commitDuration;
    uint256 public immutable revealDuration;
    uint256 public commitDeadline;
    uint256 public revealDeadline;

    // ─── Financial & Operational State ────────────────────────────────────────

    uint256 public amount;
    uint256 public deliveryDeadline;
    uint256 public immutable deliveryPeriod;
    uint256 public immutable arbiterFeeBps;

    State public currentState;

    // ─── Events ───────────────────────────────────────────────────────────────

    event FundsDeposited(address indexed buyer, uint256 amount, uint256 deliveryDeadline);
    event DeliveryConfirmed(address indexed buyer, address indexed seller, uint256 amount);
    event DisputeRaised(address indexed raisedBy, uint256 commitDeadline);
    event VoteCommitted(address indexed arbiter);
    event RevealPhaseStarted(uint256 revealDeadline);
    event VoteRevealed(address indexed arbiter, bool voteForSeller);
    event DisputeResolved(bool releasedToSeller, uint256 winnerPayout, uint256 totalArbiterFee);
    event ArbiterFeePaid(address indexed arbiter, uint256 fee);
    event RefundedAfterTimeout(address indexed buyer, uint256 amount);
    event InactiveArbiterDefaultRefund(address indexed buyer, uint256 amount);

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyBuyer() {
        require(msg.sender == buyer, "CommitRevealEscrow: caller is not the buyer");
        _;
    }

    modifier onlySeller() {
        require(msg.sender == seller, "CommitRevealEscrow: caller is not the seller");
        _;
    }

    modifier onlyParty() {
        require(
            msg.sender == buyer || msg.sender == seller,
            "CommitRevealEscrow: caller is neither buyer nor seller"
        );
        _;
    }

    modifier onlyArbiter() {
        require(isArbiter[msg.sender], "CommitRevealEscrow: caller is not a registered arbiter");
        _;
    }

    modifier inState(State expected) {
        require(currentState == expected, "CommitRevealEscrow: invalid state for this action");
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(
        address payable _seller,
        address[3] memory _arbiters,
        uint256 _deliveryPeriod,
        uint256 _commitDuration,
        uint256 _revealDuration,
        uint256 _arbiterFeeBps
    ) {
        require(_seller != address(0), "CommitRevealEscrow: seller is zero address");
        require(_seller != msg.sender, "CommitRevealEscrow: buyer and seller must differ");
        require(_deliveryPeriod > 0, "CommitRevealEscrow: delivery period must be positive");
        require(_commitDuration > 0, "CommitRevealEscrow: commit duration must be positive");
        require(_revealDuration > 0, "CommitRevealEscrow: reveal duration must be positive");
        require(_arbiterFeeBps <= 1000, "CommitRevealEscrow: arbiter fee exceeds 10% cap");

        buyer = payable(msg.sender);
        seller = _seller;
        deliveryPeriod = _deliveryPeriod;
        commitDuration = _commitDuration;
        revealDuration = _revealDuration;
        arbiterFeeBps = _arbiterFeeBps;

        for (uint8 i = 0; i < ARBITER_COUNT; i++) {
            address a = _arbiters[i];
            require(a != address(0), "CommitRevealEscrow: arbiter is zero address");
            require(a != msg.sender, "CommitRevealEscrow: arbiter must differ from buyer");
            require(a != _seller, "CommitRevealEscrow: arbiter must differ from seller");
            require(!isArbiter[a], "CommitRevealEscrow: duplicate arbiter address");
            arbiters[i] = a;
            isArbiter[a] = true;
        }

        currentState = State.AWAITING_PAYMENT;
    }

    // ─── Deposit & Happy Path ─────────────────────────────────────────────────

    function deposit() external payable onlyBuyer inState(State.AWAITING_PAYMENT) {
        require(msg.value > 0, "CommitRevealEscrow: deposit must be positive");
        amount = msg.value;
        deliveryDeadline = block.timestamp + deliveryPeriod;
        currentState = State.AWAITING_DELIVERY;
        emit FundsDeposited(msg.sender, msg.value, deliveryDeadline);
    }

    function confirmDelivery() external onlyBuyer inState(State.AWAITING_DELIVERY) nonReentrant {
        uint256 payout = amount;
        currentState = State.COMPLETE; // CEI
        amount = 0;

        (bool success, ) = seller.call{value: payout}("");
        require(success, "CommitRevealEscrow: transfer to seller failed");

        emit DeliveryConfirmed(buyer, seller, payout);
    }

    function refundAfterTimeout() external onlyBuyer inState(State.AWAITING_DELIVERY) nonReentrant {
        require(block.timestamp >= deliveryDeadline, "CommitRevealEscrow: delivery deadline not reached");

        uint256 payout = amount;
        currentState = State.REFUNDED; // CEI
        amount = 0;

        (bool success, ) = buyer.call{value: payout}("");
        require(success, "CommitRevealEscrow: refund failed");

        emit RefundedAfterTimeout(buyer, payout);
    }

    // ─── Dispute & Commit-Reveal Voting ───────────────────────────────────────

    /// @notice Buyer or seller escalates disagreement to the arbiter panel.
    ///         Starts the commit phase countdown.
    function raiseDispute() external onlyParty inState(State.AWAITING_DELIVERY) {
        currentState = State.DISPUTED_COMMIT;
        commitDeadline = block.timestamp + commitDuration;
        emit DisputeRaised(msg.sender, commitDeadline);
    }

    /// @notice Arbiter submits their cryptographic commitment hash.
    ///         H = keccak256(abi.encodePacked(voteForSeller, salt, arbiterAddress))
    /// @param commitment Preimage hash sealing the vote.
    function commitVote(bytes32 commitment)
        external
        onlyArbiter
        inState(State.DISPUTED_COMMIT)
    {
        require(block.timestamp <= commitDeadline, "CommitRevealEscrow: commit phase has ended");
        require(!hasCommitted[msg.sender], "CommitRevealEscrow: arbiter has already committed");
        require(commitment != bytes32(0), "CommitRevealEscrow: invalid zero commitment");

        voteCommitments[msg.sender] = commitment;
        hasCommitted[msg.sender] = true;
        commitCount++;

        emit VoteCommitted(msg.sender);

        // If all 3 arbiters have submitted their commitments, reveal phase opens immediately
        if (commitCount == ARBITER_COUNT) {
            _startRevealPhase();
        }
    }

    /// @notice Opens the reveal phase if commit deadline has expired.
    function startRevealPhase() external inState(State.DISPUTED_COMMIT) {
        require(block.timestamp > commitDeadline, "CommitRevealEscrow: commit phase has not expired yet");
        _startRevealPhase();
    }

    function _startRevealPhase() internal {
        currentState = State.DISPUTED_REVEAL;
        revealDeadline = block.timestamp + revealDuration;
        emit RevealPhaseStarted(revealDeadline);
    }

    /// @notice Arbiter reveals their vote by providing the original boolean vote and secret salt.
    ///         The contract verifies keccak256(vote, salt, msg.sender) == storedCommitment.
    /// @param voteForSeller True if voting for seller, false for buyer.
    /// @param salt 32-byte secret random salt chosen during commit phase.
    function revealVote(bool voteForSeller, bytes32 salt)
        external
        onlyArbiter
        inState(State.DISPUTED_REVEAL)
        nonReentrant
    {
        require(block.timestamp <= revealDeadline, "CommitRevealEscrow: reveal phase has ended");
        require(hasCommitted[msg.sender], "CommitRevealEscrow: arbiter did not commit a vote");
        require(!hasRevealed[msg.sender], "CommitRevealEscrow: vote has already been revealed");

        // Cryptographic preimage verification (msg.sender bound to prevent replay/copying)
        bytes32 expectedCommitment = keccak256(abi.encodePacked(voteForSeller, salt, msg.sender));
        require(
            expectedCommitment == voteCommitments[msg.sender],
            "CommitRevealEscrow: hash mismatch - invalid reveal"
        );

        hasRevealed[msg.sender] = true;

        if (voteForSeller) {
            votesForSeller++;
        } else {
            votesForBuyer++;
        }

        emit VoteRevealed(msg.sender, voteForSeller);

        // Immediate resolution upon reaching 2-of-3 majority
        if (votesForSeller >= 2) {
            _resolveDispute(true);
        } else if (votesForBuyer >= 2) {
            _resolveDispute(false);
        }
    }

    /// @notice Failsafe: if arbiters fail to reveal and reveal deadline expires without quorum,
    ///         funds are refunded to buyer to prevent permanent fund lock (DoS immunity).
    function handleRevealTimeout() external inState(State.DISPUTED_REVEAL) nonReentrant {
        require(block.timestamp > revealDeadline, "CommitRevealEscrow: reveal phase still active");

        // If one side has more revealed votes, they win. If tied or 0, refund buyer.
        bool releaseToSeller = false;
        if (votesForSeller > votesForBuyer) {
            releaseToSeller = true;
            _resolveDispute(true);
        } else if (votesForBuyer > votesForSeller) {
            _resolveDispute(false);
        } else {
            // Deadlock / total inaction: refund buyer without arbiter fee
            uint256 payout = amount;
            currentState = State.REFUNDED;
            amount = 0;

            (bool success, ) = buyer.call{value: payout}("");
            require(success, "CommitRevealEscrow: deadlock refund failed");

            emit InactiveArbiterDefaultRefund(buyer, payout);
        }
    }

    // ─── Internal Dispute Resolution ──────────────────────────────────────────

    function _resolveDispute(bool releaseToSeller) internal {
        uint256 total = amount;
        currentState = State.COMPLETE; // CEI
        amount = 0;

        uint256 totalFee = (total * arbiterFeeBps) / 10_000;
        uint256 feePerArbiter = totalFee / ARBITER_COUNT;
        uint256 dust = totalFee - (feePerArbiter * ARBITER_COUNT);
        uint256 winnerPayout = total - totalFee + dust;

        for (uint8 i = 0; i < ARBITER_COUNT; i++) {
            if (feePerArbiter > 0) {
                (bool feeOk, ) = payable(arbiters[i]).call{value: feePerArbiter}("");
                require(feeOk, "CommitRevealEscrow: fee transfer failed");
                emit ArbiterFeePaid(arbiters[i], feePerArbiter);
            }
        }

        address payable winner = releaseToSeller ? seller : buyer;
        (bool ok, ) = winner.call{value: winnerPayout}("");
        require(ok, "CommitRevealEscrow: dispute payout failed");

        emit DisputeResolved(releaseToSeller, winnerPayout, totalFee);
    }

    // ─── Helper Pure Function ─────────────────────────────────────────────────

    /// @notice Utility helper to compute the commitment hash.
    /// @param voteForSeller True if voting for seller, false for buyer.
    /// @param salt 32-byte secret random salt.
    /// @param arbiter Address of the arbiter casting the vote.
    function generateCommitmentHash(
        bool voteForSeller,
        bytes32 salt,
        address arbiter
    ) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(voteForSeller, salt, arbiter));
    }
}
