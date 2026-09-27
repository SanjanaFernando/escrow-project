// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title  Milestone / Tranche-Based Multi-Stage Escrow
/// @author EC8204 Group Project, University of Ruhuna
/// @notice Implements progressive fund release across sequential milestones.
///         Disputes are scoped to individual milestones without freezing unrelated project funds.
///         Arbitrated by a 2-of-3 independent arbiter panel with proportional dispute fee splits.
///
/// @dev    Security Design:
///         - Checks-Effects-Interactions (CEI) pattern adhered to on all payouts.
///         - OpenZeppelin ReentrancyGuard prevents reentrancy during external calls.
///         - Strict access control via named modifiers (onlyBuyer, onlySeller, onlyParty, onlyArbiter).
///         - Sequential state progression prevents skipping or double-completing milestones.
///         - Dynamic deadline calculation: milestone i+1 clock starts when milestone i resolves.
contract MilestoneEscrow is ReentrancyGuard {

    // ─── Data Structures ──────────────────────────────────────────────────────

    enum MilestoneState {
        PENDING,    // 0: Milestone active; awaiting work submission by seller
        SUBMITTED,  // 1: Seller has submitted work; awaiting buyer approval or dispute
        APPROVED,   // 2: Milestone approved; funds released to seller
        DISPUTED,   // 3: Milestone escalated to arbitration panel
        REFUNDED    // 4: Milestone refunded to buyer (via dispute or timeout)
    }

    struct Milestone {
        string description;       // Deliverable specification
        uint256 amount;           // Tranche payout (in wei)
        uint256 duration;         // Duration in seconds allotted for this milestone
        uint256 deadline;         // Active Unix timestamp deadline (0 until milestone starts)
        MilestoneState state;     // Current lifecycle state of this milestone
        uint8 votesForSeller;     // Arbiter vote count for seller
        uint8 votesForBuyer;      // Arbiter vote count for buyer
    }

    // ─── Parties & Panel ──────────────────────────────────────────────────────

    address payable public immutable buyer;
    address payable public immutable seller;

    uint8 public constant ARBITER_COUNT = 3;
    address[3] public arbiters;
    mapping(address => bool) public isArbiter;

    // milestoneIndex => arbiter => hasVoted
    mapping(uint256 => mapping(address => bool)) public hasVotedOnMilestone;

    // ─── Financial & Operational State ────────────────────────────────────────

    Milestone[] public milestones;
    uint256 public currentMilestoneIndex;
    uint256 public immutable totalDeposit;
    uint256 public totalReleasedToSeller;
    uint256 public totalRefundedToBuyer;
    uint256 public totalArbiterFeesPaid;

    /// @notice Arbiter fee in basis points (1 bp = 0.01%, max 1000 = 10%).
    ///         Charged only when a milestone goes through arbitration.
    uint256 public immutable arbiterFeeBps;

    // ─── Events ───────────────────────────────────────────────────────────────

    event MilestoneCreated(uint256 indexed index, string description, uint256 amount, uint256 duration);
    event MilestoneStarted(uint256 indexed index, uint256 deadline);
    event MilestoneSubmitted(uint256 indexed index, address indexed seller);
    event MilestoneApproved(uint256 indexed index, address indexed buyer, uint256 payout);
    event MilestoneDisputed(uint256 indexed index, address indexed raisedBy);
    event MilestoneVoteCast(
        uint256 indexed index,
        address indexed arbiter,
        bool voteForSeller,
        uint8 votesForSeller,
        uint8 votesForBuyer
    );
    event MilestoneResolved(
        uint256 indexed index,
        bool releasedToSeller,
        uint256 winnerPayout,
        uint256 totalArbiterFee
    );
    event MilestoneRefundedAfterTimeout(uint256 indexed index, address indexed buyer, uint256 refundAmount);
    event ArbiterFeePaid(uint256 indexed index, address indexed arbiter, uint256 fee);
    event EscrowCompleted(uint256 totalReleased, uint256 totalRefunded);

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyBuyer() {
        require(msg.sender == buyer, "MilestoneEscrow: caller is not the buyer");
        _;
    }

    modifier onlySeller() {
        require(msg.sender == seller, "MilestoneEscrow: caller is not the seller");
        _;
    }

    modifier onlyParty() {
        require(
            msg.sender == buyer || msg.sender == seller,
            "MilestoneEscrow: caller is neither buyer nor seller"
        );
        _;
    }

    modifier onlyArbiter() {
        require(isArbiter[msg.sender], "MilestoneEscrow: caller is not a registered arbiter");
        _;
    }

    modifier validActiveIndex(uint256 index) {
        require(index == currentMilestoneIndex, "MilestoneEscrow: milestone is not currently active");
        require(index < milestones.length, "MilestoneEscrow: all milestones have concluded");
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    /// @notice Creates a new milestone-based escrow.
    /// @param _seller payable address of the seller receiving tranche releases.
    /// @param _arbiters fixed array of 3 distinct arbiter addresses.
    /// @param _arbiterFeeBps arbiter fee basis points (capped at 1000 = 10%).
    /// @param _descriptions array of deliverable descriptions for each milestone.
    /// @param _amounts array of tranche amounts in wei for each milestone.
    /// @param _durations array of milestone durations in seconds.
    constructor(
        address payable _seller,
        address[3] memory _arbiters,
        uint256 _arbiterFeeBps,
        string[] memory _descriptions,
        uint256[] memory _amounts,
        uint256[] memory _durations
    ) payable {
        require(_seller != address(0), "MilestoneEscrow: seller is zero address");
        require(_seller != msg.sender, "MilestoneEscrow: buyer and seller must differ");
        require(_arbiterFeeBps <= 1000, "MilestoneEscrow: arbiter fee exceeds 10% cap");
        require(_descriptions.length > 0, "MilestoneEscrow: must have at least one milestone");
        require(
            _descriptions.length == _amounts.length && _amounts.length == _durations.length,
            "MilestoneEscrow: milestone array length mismatch"
        );

        buyer = payable(msg.sender);
        seller = _seller;
        arbiterFeeBps = _arbiterFeeBps;

        // Register arbiters
        for (uint8 i = 0; i < ARBITER_COUNT; i++) {
            address a = _arbiters[i];
            require(a != address(0), "MilestoneEscrow: arbiter is zero address");
            require(a != msg.sender, "MilestoneEscrow: arbiter must differ from buyer");
            require(a != _seller, "MilestoneEscrow: arbiter must differ from seller");
            require(!isArbiter[a], "MilestoneEscrow: duplicate arbiter address");
            arbiters[i] = a;
            isArbiter[a] = true;
        }

        uint256 sumAmounts = 0;
        for (uint256 i = 0; i < _descriptions.length; i++) {
            require(_amounts[i] > 0, "MilestoneEscrow: milestone amount must be positive");
            require(_durations[i] > 0, "MilestoneEscrow: milestone duration must be positive");

            milestones.push(Milestone({
                description: _descriptions[i],
                amount: _amounts[i],
                duration: _durations[i],
                deadline: 0,
                state: MilestoneState.PENDING,
                votesForSeller: 0,
                votesForBuyer: 0
            }));

            sumAmounts += _amounts[i];
            emit MilestoneCreated(i, _descriptions[i], _amounts[i], _durations[i]);
        }

        require(msg.value == sumAmounts, "MilestoneEscrow: deposit value must equal sum of milestones");
        totalDeposit = msg.value;

        // Start countdown for the first milestone
        milestones[0].deadline = block.timestamp + milestones[0].duration;
        emit MilestoneStarted(0, milestones[0].deadline);
    }

    // ─── Milestone Progression Actions ────────────────────────────────────────

    /// @notice Seller marks deliverables for current active milestone as completed.
    /// @param index The active milestone index.
    function submitMilestone(uint256 index)
        external
        onlySeller
        validActiveIndex(index)
    {
        Milestone storage m = milestones[index];
        require(m.state == MilestoneState.PENDING, "MilestoneEscrow: milestone not in PENDING state");

        m.state = MilestoneState.SUBMITTED;
        emit MilestoneSubmitted(index, msg.sender);
    }

    /// @notice Buyer reviews and approves the submitted milestone work, releasing the tranche.
    /// @param index The active milestone index.
    function approveMilestone(uint256 index)
        external
        onlyBuyer
        validActiveIndex(index)
        nonReentrant
    {
        Milestone storage m = milestones[index];
        require(m.state == MilestoneState.SUBMITTED, "MilestoneEscrow: milestone not submitted for approval");

        uint256 payout = m.amount;
        m.state = MilestoneState.APPROVED; // CEI effect
        totalReleasedToSeller += payout;

        _advanceToNextMilestone();

        (bool success, ) = seller.call{value: payout}("");
        require(success, "MilestoneEscrow: seller payout failed");

        emit MilestoneApproved(index, msg.sender, payout);
    }

    /// @notice Buyer or seller raises a dispute on the active milestone.
    /// @param index The active milestone index.
    function disputeMilestone(uint256 index)
        external
        onlyParty
        validActiveIndex(index)
    {
        Milestone storage m = milestones[index];
        require(
            m.state == MilestoneState.PENDING || m.state == MilestoneState.SUBMITTED,
            "MilestoneEscrow: invalid state to raise dispute"
        );

        m.state = MilestoneState.DISPUTED;
        emit MilestoneDisputed(index, msg.sender);
    }

    /// @notice Registered arbiter casts binding vote on disputed milestone.
    ///         Atomic 2-of-3 majority triggers fee split and payout to winner.
    /// @param index Active milestone index.
    /// @param voteForSeller True if voting in favor of seller, false for buyer refund.
    function voteMilestoneDispute(uint256 index, bool voteForSeller)
        external
        onlyArbiter
        validActiveIndex(index)
        nonReentrant
    {
        Milestone storage m = milestones[index];
        require(m.state == MilestoneState.DISPUTED, "MilestoneEscrow: milestone is not disputed");
        require(!hasVotedOnMilestone[index][msg.sender], "MilestoneEscrow: arbiter has already voted on this milestone");

        hasVotedOnMilestone[index][msg.sender] = true;

        if (voteForSeller) {
            m.votesForSeller++;
        } else {
            m.votesForBuyer++;
        }

        emit MilestoneVoteCast(index, msg.sender, voteForSeller, m.votesForSeller, m.votesForBuyer);

        if (m.votesForSeller >= 2) {
            _resolveMilestoneDispute(index, true);
        } else if (m.votesForBuyer >= 2) {
            _resolveMilestoneDispute(index, false);
        }
    }

    /// @notice Buyer reclaims milestone funds if seller fails to submit work before deadline.
    /// @param index Active milestone index.
    function refundMilestoneAfterTimeout(uint256 index)
        external
        onlyBuyer
        validActiveIndex(index)
        nonReentrant
    {
        Milestone storage m = milestones[index];
        require(
            m.state == MilestoneState.PENDING || m.state == MilestoneState.SUBMITTED,
            "MilestoneEscrow: milestone not in valid timeout state"
        );
        require(block.timestamp >= m.deadline, "MilestoneEscrow: milestone deadline has not passed yet");

        uint256 refundAmount = m.amount;
        m.state = MilestoneState.REFUNDED; // CEI effect
        totalRefundedToBuyer += refundAmount;

        _advanceToNextMilestone();

        (bool success, ) = buyer.call{value: refundAmount}("");
        require(success, "MilestoneEscrow: timeout refund failed");

        emit MilestoneRefundedAfterTimeout(index, buyer, refundAmount);
    }

    // ─── Internal Helpers ─────────────────────────────────────────────────────

    /// @dev Resolves a 2-of-3 arbiter dispute resolution atomically.
    function _resolveMilestoneDispute(uint256 index, bool releaseToSeller) internal {
        Milestone storage m = milestones[index];
        uint256 trancheAmount = m.amount;

        m.state = releaseToSeller ? MilestoneState.APPROVED : MilestoneState.REFUNDED;

        // Calculate arbiter fee split
        uint256 totalFee = (trancheAmount * arbiterFeeBps) / 10_000;
        uint256 feePerArbiter = totalFee / ARBITER_COUNT;
        uint256 dust = totalFee - (feePerArbiter * ARBITER_COUNT);
        uint256 winnerPayout = trancheAmount - totalFee + dust;

        if (releaseToSeller) {
            totalReleasedToSeller += winnerPayout;
        } else {
            totalRefundedToBuyer += winnerPayout;
        }
        totalArbiterFeesPaid += totalFee;

        _advanceToNextMilestone();

        // Transfer arbiter fees
        for (uint8 i = 0; i < ARBITER_COUNT; i++) {
            if (feePerArbiter > 0) {
                (bool feeOk, ) = payable(arbiters[i]).call{value: feePerArbiter}("");
                require(feeOk, "MilestoneEscrow: arbiter fee transfer failed");
                emit ArbiterFeePaid(index, arbiters[i], feePerArbiter);
            }
        }

        // Payout winner
        address payable recipient = releaseToSeller ? seller : buyer;
        (bool payoutOk, ) = recipient.call{value: winnerPayout}("");
        require(payoutOk, "MilestoneEscrow: winner dispute payout failed");

        emit MilestoneResolved(index, releaseToSeller, winnerPayout, totalFee);
    }

    /// @dev Increments active milestone index and begins countdown for subsequent milestone.
    function _advanceToNextMilestone() internal {
        currentMilestoneIndex++;
        if (currentMilestoneIndex < milestones.length) {
            milestones[currentMilestoneIndex].deadline = block.timestamp + milestones[currentMilestoneIndex].duration;
            emit MilestoneStarted(currentMilestoneIndex, milestones[currentMilestoneIndex].deadline);
        } else {
            emit EscrowCompleted(totalReleasedToSeller, totalRefundedToBuyer);
        }
    }

    // ─── View Functions ───────────────────────────────────────────────────────

    /// @notice Returns total number of defined milestones.
    function getMilestoneCount() external view returns (uint256) {
        return milestones.length;
    }

    /// @notice Returns full details for a given milestone.
    function getMilestone(uint256 index)
        external
        view
        returns (
            string memory description,
            uint256 amount,
            uint256 duration,
            uint256 deadline,
            MilestoneState state,
            uint8 votesForSeller,
            uint8 votesForBuyer
        )
    {
        require(index < milestones.length, "MilestoneEscrow: index out of bounds");
        Milestone storage m = milestones[index];
        return (
            m.description,
            m.amount,
            m.duration,
            m.deadline,
            m.state,
            m.votesForSeller,
            m.votesForBuyer
        );
    }

    /// @notice Checks if an address is registered as an arbiter on this contract.
    function isRegisteredArbiter(address account) external view returns (bool) {
        return isArbiter[account];
    }

    /// @notice Returns whether all milestones have concluded.
    function isCompleted() external view returns (bool) {
        return currentMilestoneIndex >= milestones.length;
    }
}
