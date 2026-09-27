// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Smart Contract Fund Escrow
/// @author EC8204 Group Project
/// @notice Holds a buyer's funds until agreed conditions are met, and
///         releases them automatically to the seller or back to the buyer
///         based on delivery confirmation, arbiter decision, or a timeout.
/// @dev Security notes (for the "Cyber Security" half of this module):
///      - Follows Checks-Effects-Interactions: state is updated BEFORE any
///        external call (ETH transfer), which prevents reentrancy attacks.
///      - Uses OpenZeppelin's ReentrancyGuard as a second line of defense.
///      - Uses `call{value: ...}` instead of `transfer`/`send` to avoid the
///        2300-gas stipend problem that can permanently lock funds if the
///        seller is a contract with a non-trivial receive() function.
///      - Access is restricted with modifiers so only the correct party
///        (buyer / seller / arbiter) can trigger each state transition.
///      - A deadline-based refund path prevents funds from being locked
///        forever if the seller simply disappears (a griefing / DoS risk
///        in naive escrow designs).
contract Escrow is ReentrancyGuard {
    enum State {
        AWAITING_PAYMENT,
        AWAITING_DELIVERY,
        COMPLETE,
        DISPUTED,
        REFUNDED
    }

    address payable public immutable buyer;
    address payable public immutable seller;
    address public immutable arbiter;

    uint256 public amount;
    uint256 public deliveryDeadline; // unix timestamp, set once funds are deposited
    uint256 public immutable deliveryPeriod; // seconds the seller has to deliver after deposit

    State public currentState;

    event FundsDeposited(address indexed buyer, uint256 amount, uint256 deliveryDeadline);
    event DeliveryConfirmed(address indexed buyer, address indexed seller, uint256 amount);
    event DisputeRaised(address indexed raisedBy);
    event DisputeResolved(address indexed arbiter, bool releasedToSeller, uint256 amount);
    event RefundedAfterTimeout(address indexed buyer, uint256 amount);

    modifier onlyBuyer() {
        require(msg.sender == buyer, "Escrow: caller is not the buyer");
        _;
    }

    modifier onlySeller() {
        require(msg.sender == seller, "Escrow: caller is not the seller");
        _;
    }

    modifier onlyArbiter() {
        require(msg.sender == arbiter, "Escrow: caller is not the arbiter");
        _;
    }

    modifier inState(State expected) {
        require(currentState == expected, "Escrow: invalid state for this action");
        _;
    }

    /// @param _seller address that will receive funds once delivery is confirmed
    /// @param _arbiter neutral third party who resolves disputes
    /// @param _deliveryPeriod seconds the seller has to deliver, starting when funds are deposited
    constructor(address payable _seller, address _arbiter, uint256 _deliveryPeriod) {
        require(_seller != address(0) && _arbiter != address(0), "Escrow: zero address");
        require(_seller != msg.sender, "Escrow: buyer and seller must differ");
        require(_arbiter != msg.sender && _arbiter != _seller, "Escrow: arbiter must be independent");
        require(_deliveryPeriod > 0, "Escrow: delivery period must be positive");

        buyer = payable(msg.sender);
        seller = _seller;
        arbiter = _arbiter;
        deliveryPeriod = _deliveryPeriod;
        currentState = State.AWAITING_PAYMENT;
    }

    /// @notice Buyer locks funds into escrow. Starts the delivery countdown.
    function deposit() external payable onlyBuyer inState(State.AWAITING_PAYMENT) {
        require(msg.value > 0, "Escrow: deposit must be greater than zero");
        amount = msg.value;
        deliveryDeadline = block.timestamp + deliveryPeriod;
        currentState = State.AWAITING_DELIVERY;
        emit FundsDeposited(msg.sender, msg.value, deliveryDeadline);
    }

    /// @notice Buyer confirms goods/services were received as agreed; releases funds to seller.
    function confirmDelivery() external onlyBuyer inState(State.AWAITING_DELIVERY) nonReentrant {
        uint256 payout = amount;
        currentState = State.COMPLETE; // effect before interaction
        amount = 0;

        (bool success, ) = seller.call{value: payout}("");
        require(success, "Escrow: transfer to seller failed");

        emit DeliveryConfirmed(buyer, seller, payout);
    }

    /// @notice Either buyer or seller can escalate a disagreement to the arbiter.
    function raiseDispute() external inState(State.AWAITING_DELIVERY) {
        require(msg.sender == buyer || msg.sender == seller, "Escrow: only buyer or seller may dispute");
        currentState = State.DISPUTED;
        emit DisputeRaised(msg.sender);
    }

    /// @notice Arbiter decides the outcome of a dispute.
    /// @param releaseToSeller true = pay seller, false = refund buyer
    function resolveDispute(bool releaseToSeller) external onlyArbiter inState(State.DISPUTED) nonReentrant {
        uint256 payout = amount;
        currentState = State.COMPLETE;
        amount = 0;

        address payable recipient = releaseToSeller ? seller : buyer;
        (bool success, ) = recipient.call{value: payout}("");
        require(success, "Escrow: dispute payout failed");

        emit DisputeResolved(arbiter, releaseToSeller, payout);
    }

    /// @notice If the seller never delivers and the deadline passes, buyer can reclaim funds.
    function refundAfterTimeout() external onlyBuyer inState(State.AWAITING_DELIVERY) nonReentrant {
        require(block.timestamp >= deliveryDeadline, "Escrow: delivery deadline has not passed yet");

        uint256 payout = amount;
        currentState = State.REFUNDED;
        amount = 0;

        (bool success, ) = buyer.call{value: payout}("");
        require(success, "Escrow: refund failed");

        emit RefundedAfterTimeout(buyer, payout);
    }

    /// @notice Convenience view for frontends/tests.
    function getDetails()
        external
        view
        returns (
            address _buyer,
            address _seller,
            address _arbiter,
            uint256 _amount,
            uint256 _deliveryDeadline,
            State _state
        )
    {
        return (buyer, seller, arbiter, amount, deliveryDeadline, currentState);
    }
}
