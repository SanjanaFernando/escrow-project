// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title  Smart Contract Fund Escrow (Enhanced — EC8204 Group Project)
/// @author EC8204 Group Project, University of Ruhuna
/// @notice Holds a buyer's funds until agreed conditions are met, then releases
///         them automatically to the seller or back to the buyer based on:
///         (a) buyer confirmation of delivery,
///         (b) off-chain EIP-712 signed delivery receipt from buyer,
///         (c) a 2-of-3 majority arbiter vote, or
///         (d) a timeout refund if the seller never delivers.
///
/// @dev    Security design highlights (for the Cyber Security half of EC8204):
///
///         REENTRANCY
///         - Follows Checks-Effects-Interactions strictly: state variables are
///           updated *before* any external ETH transfer so a re-entrant call
///           cannot replay the payout.
///         - OpenZeppelin's `nonReentrant` modifier provides a second defence layer.
///
///         UNAUTHORIZED ACCESS
///         - Named modifiers (`onlyBuyer`, `onlySeller`, `onlyParty`, `onlyArbiter`)
///           restrict every state-changing function to the correct role.
///         - `onlyParty` is a *reusable* modifier (not an inline require) — avoids
///           the anti-pattern of embedding access control inside function bodies.
///
///         GAS STIPEND / STUCK FUNDS
///         - Uses low-level `call{value:}` instead of `transfer`/`send` to avoid
///           the 2300-gas stipend DoS that permanently locks funds when the recipient
///           is a contract with a non-trivial `receive()` function.
///
///         STATE MACHINE CORRECTNESS
///         - `inState()` enforces a strict finite-state machine.
///           Invalid transitions revert — unreachable states are unreachable by
///           construction (a formal reachability safety property).
///
///         CENTRALIZATION / ARBITER TRUST
///         - Replaces a single trusted arbiter with a 2-of-3 multi-arbiter vote.
///           No single arbiter can unilaterally redirect funds, eliminating the
///           single-point-of-failure (and corruption) risk.
///
///         DENIAL OF SERVICE / GRIEFING
///         - `refundAfterTimeout()` lets the buyer reclaim funds once `deliveryDeadline`
///           passes, preventing funds from being locked forever if the seller disappears.
///
///         ARBITER FEE
///         - Fee is expressed in basis points (1 bp = 0.01%) and capped at 10% (1000 bps).
///           It is deducted only on the dispute path, split equally among all three
///           arbiters regardless of how they voted.
///
///         CRYPTOGRAPHIC DELIVERY & EVIDENCE ATTESTATION
///         - EIP-712 typed structured data signing allows gasless buyer delivery receipts.
///         - IPFS decentralized evidence registry anchors tamper-proof CIDs during disputes.

contract Escrow is ReentrancyGuard, EIP712 {

    // ─── State Machine ────────────────────────────────────────────────────────

    /// @notice Lifecycle states of the escrow.
    /// @dev Transitions are strictly enforced by the `inState()` modifier:
    ///      AWAITING_PAYMENT → AWAITING_DELIVERY (on deposit)
    ///      AWAITING_DELIVERY → COMPLETE  (on confirmDelivery)
    ///      AWAITING_DELIVERY → DISPUTED  (on raiseDispute)
    ///      AWAITING_DELIVERY → REFUNDED  (on refundAfterTimeout, after deadline)
    ///      DISPUTED → COMPLETE           (on castVote reaching 2-of-3 majority)
    enum State {
        AWAITING_PAYMENT,   // 0 — deployed; no funds deposited yet
        AWAITING_DELIVERY,  // 1 — funds locked; seller must deliver before deadline
        COMPLETE,           // 2 — funds paid out (to seller or buyer via arbiter)
        DISPUTED,           // 3 — dispute raised; arbiters casting votes
        REFUNDED            // 4 — buyer reclaimed funds after deadline
    }

    // ─── Parties ──────────────────────────────────────────────────────────────

    /// @notice The buyer who deposits funds and confirms delivery.
    address payable public immutable buyer;

    /// @notice The seller who delivers and receives payment on success.
    address payable public immutable seller;

    // ─── Multi-Arbiter Configuration ─────────────────────────────────────────

    /// @notice Fixed arbiter panel size (3 arbiters — supports 2-of-3 majority voting).
    uint8 public constant ARBITER_COUNT = 3;

    /// @notice The three independent arbiters (set at construction, immutable thereafter).
    address[3] public arbiters;

    /// @notice O(1) lookup: true if an address is one of the three registered arbiters.
    mapping(address => bool) public isArbiter;

    /// @notice True once an arbiter has cast their vote (prevents double-voting).
    mapping(address => bool) public hasVoted;

    /// @notice Running tally of votes cast in favour of releasing funds to the seller.
    uint8 public votesForSeller;

    /// @notice Running tally of votes cast in favour of refunding the buyer.
    uint8 public votesForBuyer;

    // ─── Financial Parameters ─────────────────────────────────────────────────

    /// @notice Amount currently held in escrow (wei). Set on deposit; zeroed on payout.
    uint256 public amount;

    /// @notice Unix timestamp after which the buyer may claim a timeout refund.
    uint256 public deliveryDeadline;

    /// @notice Seconds the seller has to deliver, measured from the moment of deposit.
    uint256 public immutable deliveryPeriod;

    /// @notice Arbiter fee in basis points (1 bp = 0.01%, max 1000 = 10%).
    ///         Charged only on the dispute path; split equally among all three arbiters.
    uint256 public immutable arbiterFeeBps;

    // ─── Current State ────────────────────────────────────────────────────────

    /// @notice Active lifecycle state of this escrow instance.
    State public currentState;

    // ─── Events ───────────────────────────────────────────────────────────────

    /// @notice Emitted when the buyer successfully locks funds into escrow.
    /// @param buyer            The buyer's address.
    /// @param amount           Deposited amount in wei.
    /// @param deliveryDeadline Unix timestamp by which the seller must deliver.
    event FundsDeposited(address indexed buyer, uint256 amount, uint256 deliveryDeadline);

    /// @notice Emitted when the buyer confirms delivery and releases funds to the seller.
    /// @param buyer  The buyer's address.
    /// @param seller The seller's address.
    /// @param amount Amount released in wei.
    event DeliveryConfirmed(address indexed buyer, address indexed seller, uint256 amount);

    /// @notice Emitted when the buyer or seller escalates to arbitration.
    /// @param raisedBy Address that raised the dispute (buyer or seller).
    event DisputeRaised(address indexed raisedBy);

    /// @notice Emitted each time an arbiter casts their vote.
    /// @param arbiter        The voting arbiter's address.
    /// @param voteForSeller  True if the vote was in favour of the seller.
    /// @param votesForSeller Running total of seller-votes after this cast.
    /// @param votesForBuyer  Running total of buyer-votes after this cast.
    event ArbiterVoteCast(
        address indexed arbiter,
        bool voteForSeller,
        uint8 votesForSeller,
        uint8 votesForBuyer
    );

    /// @notice Emitted when a 2-of-3 arbiter majority is reached and the dispute is resolved.
    /// @param releasedToSeller True if funds went to the seller; false if refunded to buyer.
    /// @param winnerPayout     Amount received by the winning party (after arbiter fee).
    /// @param totalArbiterFee  Total fee distributed among the three arbiters.
    event DisputeResolved(bool releasedToSeller, uint256 winnerPayout, uint256 totalArbiterFee);

    /// @notice Emitted individually for each arbiter when they receive their fee share.
    /// @param arbiter Address of the fee recipient.
    /// @param fee     Fee amount in wei.
    event ArbiterFeePaid(address indexed arbiter, uint256 fee);

    /// @notice Emitted when the buyer reclaims funds after the delivery deadline expires.
    /// @param buyer  The buyer's address.
    /// @param amount Amount refunded in wei.
    event RefundedAfterTimeout(address indexed buyer, uint256 amount);

    /// @notice Emitted when the seller claims funds using an off-chain EIP-712 buyer signature.
    event DeliveryClaimedWithSignature(
        address indexed buyer,
        address indexed seller,
        uint256 amount,
        uint256 nonce
    );

    /// @notice Emitted when an evidentiary IPFS document is attached to a dispute.
    event EvidenceSubmitted(
        address indexed submitter,
        string ipfsCID,
        string description,
        uint256 timestamp
    );

    // ─── EIP-712 & IPFS Evidence Storage ─────────────────────────────────────

    /// @notice EIP-712 typehash for off-chain buyer signed delivery receipts.
    bytes32 public constant DELIVERY_RECEIPT_TYPEHASH =
        keccak256("DeliveryReceipt(address escrowContract,address seller,uint256 amount,uint256 nonce)");

    /// @notice Replay protection nonces for EIP-712 signatures.
    mapping(address => uint256) public nonces;

    struct Evidence {
        address submitter;
        string ipfsCID;
        string description;
        uint256 timestamp;
    }

    /// @notice Registry of all tamper-proof evidence items submitted during a dispute.
    Evidence[] public evidenceList;

    // ─── Modifiers ────────────────────────────────────────────────────────────

    /// @dev Reverts unless the caller is the buyer.
    modifier onlyBuyer() {
        require(msg.sender == buyer, "Escrow: caller is not the buyer");
        _;
    }

    /// @dev Reverts unless the caller is the seller.
    modifier onlySeller() {
        require(msg.sender == seller, "Escrow: caller is not the seller");
        _;
    }

    /// @dev Reverts unless the caller is either the buyer or the seller.
    ///      Using a named modifier (rather than an inline require) makes the
    ///      access control policy explicit and reusable.
    modifier onlyParty() {
        require(
            msg.sender == buyer || msg.sender == seller,
            "Escrow: caller is neither buyer nor seller"
        );
        _;
    }

    /// @dev Reverts unless the caller is a registered arbiter who has not yet voted.
    modifier onlyArbiter() {
        require(isArbiter[msg.sender], "Escrow: caller is not a registered arbiter");
        require(!hasVoted[msg.sender], "Escrow: arbiter has already voted");
        _;
    }

    /// @dev Reverts unless the contract is currently in `expected` state.
    /// @param expected The required lifecycle state.
    modifier inState(State expected) {
        require(currentState == expected, "Escrow: invalid state for this action");
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    /// @notice Deploys a new escrow between the deployer (buyer), a seller, and
    ///         three independent arbiters who may resolve disputes by 2-of-3 vote.
    /// @dev    All three arbiter addresses must be:
    ///         - Non-zero
    ///         - Distinct from each other
    ///         - Distinct from buyer and seller
    ///         Fee is capped at 10% (1000 bps) to protect against griefing.
    /// @param _seller        Payable address that receives funds on delivery confirmation.
    /// @param _arbiters      Exactly 3 independent arbiter addresses (fixed-size array).
    /// @param _deliveryPeriod Seconds from deposit until the seller's deadline expires.
    /// @param _arbiterFeeBps  Arbiter fee in basis points (0–1000). Charged only on disputes.
    constructor(
        address payable _seller,
        address[3] memory _arbiters,
        uint256 _deliveryPeriod,
        uint256 _arbiterFeeBps
    ) EIP712("EscrowDeliveryVault", "1.0.0") {
        require(_seller != address(0), "Escrow: seller is zero address");
        require(_seller != msg.sender, "Escrow: buyer and seller must differ");
        require(_deliveryPeriod > 0, "Escrow: delivery period must be positive");
        require(_arbiterFeeBps <= 1000, "Escrow: arbiter fee exceeds 10% cap");

        // Validate and register all three arbiters
        for (uint8 i = 0; i < ARBITER_COUNT; i++) {
            address a = _arbiters[i];
            require(a != address(0), "Escrow: arbiter is zero address");
            require(a != msg.sender, "Escrow: arbiter must differ from buyer");
            require(a != _seller, "Escrow: arbiter must differ from seller");
            require(!isArbiter[a], "Escrow: duplicate arbiter address");
            arbiters[i] = a;
            isArbiter[a] = true;
        }

        buyer = payable(msg.sender);
        seller = _seller;
        deliveryPeriod = _deliveryPeriod;
        arbiterFeeBps = _arbiterFeeBps;
        currentState = State.AWAITING_PAYMENT;
    }

    // ─── Buyer Actions ────────────────────────────────────────────────────────

    /// @notice Buyer locks ETH into the escrow. Starts the delivery countdown.
    /// @dev    Transitions: AWAITING_PAYMENT → AWAITING_DELIVERY.
    ///         The delivery deadline is set to `block.timestamp + deliveryPeriod`.
    ///         Reverts if called by anyone other than the buyer or with zero value.
    function deposit() external payable onlyBuyer inState(State.AWAITING_PAYMENT) {
        require(msg.value > 0, "Escrow: deposit must be greater than zero");
        amount = msg.value;
        deliveryDeadline = block.timestamp + deliveryPeriod;
        currentState = State.AWAITING_DELIVERY;
        emit FundsDeposited(msg.sender, msg.value, deliveryDeadline);
    }

    /// @notice Buyer confirms goods or services were received as agreed.
    ///         Releases the full escrowed amount to the seller immediately.
    /// @dev    Transitions: AWAITING_DELIVERY → COMPLETE.
    ///         Follows Checks-Effects-Interactions: `currentState` and `amount` are
    ///         zeroed before the external `call`, preventing reentrancy exploits.
    ///         `nonReentrant` provides a second layer of protection.
    function confirmDelivery() external onlyBuyer inState(State.AWAITING_DELIVERY) nonReentrant {
        uint256 payout = amount;
        currentState = State.COMPLETE; // effect before interaction (CEI)
        amount = 0;

        (bool success, ) = seller.call{value: payout}("");
        require(success, "Escrow: transfer to seller failed");

        emit DeliveryConfirmed(buyer, seller, payout);
    }

    /// @notice Allows the seller (or a relayer) to claim escrowed funds by presenting
    ///         an off-chain EIP-712 cryptographic signature signed by the buyer.
    ///         Follows Checks-Effects-Interactions (CEI) to eliminate reentrancy exploits.
    /// @param signature 65-byte ECDSA signature produced by buyer via eth_signTypedData_v4.
    function claimDeliveryWithSignature(bytes calldata signature)
        external
        inState(State.AWAITING_DELIVERY)
        nonReentrant
    {
        uint256 currentNonce = nonces[buyer];
        bytes32 structHash = keccak256(
            abi.encode(
                DELIVERY_RECEIPT_TYPEHASH,
                address(this),
                seller,
                amount,
                currentNonce
            )
        );

        bytes32 digest = _hashTypedDataV4(structHash);
        address recoveredSigner = ECDSA.recover(digest, signature);
        require(recoveredSigner == buyer, "Escrow: invalid delivery signature from buyer");

        nonces[buyer]++; // Replay protection: increment nonce

        uint256 payout = amount;
        currentState = State.COMPLETE; // Effect before interaction (CEI)
        amount = 0;

        (bool success, ) = seller.call{value: payout}("");
        require(success, "Escrow: transfer to seller failed");

        emit DeliveryConfirmed(buyer, seller, payout);
        emit DeliveryClaimedWithSignature(buyer, seller, payout, currentNonce);
    }

    /// @notice Buyer or seller escalates a disagreement to the arbiter panel.
    /// @dev    Transitions: AWAITING_DELIVERY → DISPUTED.
    ///         The `onlyParty` modifier restricts this to buyer and seller only —
    ///         a named modifier rather than an inline require, which is the correct
    ///         Solidity pattern for reusable, auditable access control.
    function raiseDispute() external onlyParty inState(State.AWAITING_DELIVERY) {
        currentState = State.DISPUTED;
        emit DisputeRaised(msg.sender);
    }

    /// @notice Buyer or seller anchors an immutable IPFS document CID during a dispute.
    /// @param _ipfsCID The IPFS Content Identifier (CIDv0 or CIDv1).
    /// @param _description Human-readable note summarizing the attached document.
    function submitEvidence(string calldata _ipfsCID, string calldata _description)
        external
        onlyParty
        inState(State.DISPUTED)
    {
        require(bytes(_ipfsCID).length > 0, "Escrow: IPFS CID cannot be empty");
        require(bytes(_description).length > 0, "Escrow: description cannot be empty");

        evidenceList.push(Evidence({
            submitter: msg.sender,
            ipfsCID: _ipfsCID,
            description: _description,
            timestamp: block.timestamp
        }));

        emit EvidenceSubmitted(msg.sender, _ipfsCID, _description, block.timestamp);
    }

    /// @notice Returns the total count of submitted evidence items.
    function getEvidenceCount() external view returns (uint256) {
        return evidenceList.length;
    }

    /// @notice Returns an evidence item by its index.
    function getEvidence(uint256 index)
        external
        view
        returns (
            address submitter,
            string memory ipfsCID,
            string memory description,
            uint256 timestamp
        )
    {
        require(index < evidenceList.length, "Escrow: evidence index out of bounds");
        Evidence storage e = evidenceList[index];
        return (e.submitter, e.ipfsCID, e.description, e.timestamp);
    }

    /// @notice If the seller never delivers and the deadline passes, the buyer
    ///         can reclaim the full escrowed amount without arbiter involvement.
    /// @dev    Transitions: AWAITING_DELIVERY → REFUNDED.
    ///         `block.timestamp` manipulation is bounded to ~15 s on Ethereum mainnet,
    ///         which is negligible for a 7-day (604800 s) delivery window.
    function refundAfterTimeout() external onlyBuyer inState(State.AWAITING_DELIVERY) nonReentrant {
        require(block.timestamp >= deliveryDeadline, "Escrow: delivery deadline has not passed yet");

        uint256 payout = amount;
        currentState = State.REFUNDED;
        amount = 0;

        (bool success, ) = buyer.call{value: payout}("");
        require(success, "Escrow: refund failed");

        emit RefundedAfterTimeout(buyer, payout);
    }

    // ─── Arbiter Actions ──────────────────────────────────────────────────────

    /// @notice A registered arbiter casts their binding vote on the dispute outcome.
    /// @dev    Transitions (on 2-of-3 majority): DISPUTED → COMPLETE.
    ///         Each arbiter may vote exactly once (`hasVoted` mapping prevents replay).
    ///         When a majority is reached, `_resolveDispute()` is called internally
    ///         and distributes funds atomically — no second transaction is needed.
    ///         Arbiter fees are taken only on this dispute path and split equally
    ///         among all three arbiters, independent of their individual vote direction.
    ///
    ///         Security: `nonReentrant` is applied because `_resolveDispute` makes
    ///         multiple external ETH calls. CEI is maintained in `_resolveDispute`.
    ///
    /// @param voteForSeller True to vote in favour of releasing funds to the seller;
    ///                      false to vote for refunding the buyer.
    function castVote(bool voteForSeller)
        external
        onlyArbiter
        inState(State.DISPUTED)
        nonReentrant
    {
        hasVoted[msg.sender] = true; // effect before any interaction

        if (voteForSeller) {
            votesForSeller++;
        } else {
            votesForBuyer++;
        }

        emit ArbiterVoteCast(msg.sender, voteForSeller, votesForSeller, votesForBuyer);

        // Trigger resolution as soon as a 2-of-3 majority is reached
        if (votesForSeller >= 2) {
            _resolveDispute(true);
        } else if (votesForBuyer >= 2) {
            _resolveDispute(false);
        }
        // else: third arbiter's vote is not yet needed — contract waits
    }

    // ─── Internal Helpers ─────────────────────────────────────────────────────

    /// @dev    Called internally by `castVote` once a 2-of-3 majority is reached.
    ///         Distributes arbiter fees first, then sends the net payout to the winner.
    ///
    ///         Fee arithmetic:
    ///         - totalFee     = amount × arbiterFeeBps / 10 000
    ///         - feePerArbiter = totalFee / 3  (integer division)
    ///         - dust (totalFee mod 3) stays with the winning party to avoid locking wei
    ///         - payout       = amount - totalFee + dust
    ///
    ///         CEI is strictly maintained: `currentState` and `amount` are zeroed
    ///         before any external call so reentrancy cannot replay the payout.
    ///
    /// @param releaseToSeller True to pay the seller; false to refund the buyer.
    function _resolveDispute(bool releaseToSeller) internal {
        uint256 total = amount;
        currentState = State.COMPLETE; // ← effect
        amount = 0;                    // ← effect (before all external calls)

        // Fee split — integer dust stays with winner to avoid wei lock
        uint256 totalFee = (total * arbiterFeeBps) / 10_000;
        uint256 feePerArbiter = totalFee / ARBITER_COUNT;
        uint256 dust = totalFee - (feePerArbiter * ARBITER_COUNT);
        uint256 payout = total - totalFee + dust;

        // Pay each arbiter their share (interactions)
        for (uint8 i = 0; i < ARBITER_COUNT; i++) {
            if (feePerArbiter > 0) {
                (bool feeOk, ) = payable(arbiters[i]).call{value: feePerArbiter}("");
                require(feeOk, "Escrow: arbiter fee transfer failed");
                emit ArbiterFeePaid(arbiters[i], feePerArbiter);
            }
        }

        // Pay winner (final interaction)
        address payable recipient = releaseToSeller ? seller : buyer;
        (bool ok, ) = recipient.call{value: payout}("");
        require(ok, "Escrow: dispute payout failed");

        emit DisputeResolved(releaseToSeller, payout, totalFee);
    }

    // ─── View / Pure Helpers ──────────────────────────────────────────────────

    /// @notice Returns a full snapshot of the escrow state for frontends and tests.
    /// @return _buyer            Buyer address.
    /// @return _seller           Seller address.
    /// @return _arbiters         Array of three arbiter addresses.
    /// @return _amount           Amount currently held in escrow (wei).
    /// @return _deliveryDeadline Unix timestamp of the delivery deadline (0 before deposit).
    /// @return _state            Current lifecycle state enum value.
    /// @return _votesForSeller   Votes cast for the seller so far.
    /// @return _votesForBuyer    Votes cast for the buyer so far.
    function getDetails()
        external
        view
        returns (
            address _buyer,
            address _seller,
            address[3] memory _arbiters,
            uint256 _amount,
            uint256 _deliveryDeadline,
            State _state,
            uint8 _votesForSeller,
            uint8 _votesForBuyer
        )
    {
        return (
            buyer,
            seller,
            arbiters,
            amount,
            deliveryDeadline,
            currentState,
            votesForSeller,
            votesForBuyer
        );
    }

    /// @notice Convenience check: returns true if `account` is a registered arbiter.
    /// @param  account The address to query.
    /// @return True if `account` is one of the three registered arbiters.
    function isRegisteredArbiter(address account) external view returns (bool) {
        return isArbiter[account];
    }
}
