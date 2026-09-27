// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./Escrow.sol";

/// @title  MaliciousReceiver — Reentrancy Attack Demonstration Contract
/// @notice Simulates a malicious buyer who deploys and controls an Escrow,
///         then attempts to drain it twice via reentrancy inside receive().
///
/// @dev    Attack vector:
///         1. This contract deploys Escrow — making itself the buyer.
///         2. It deposits ETH into the escrow.
///         3. After the delivery deadline it calls refundAfterTimeout().
///         4. When the Escrow sends ETH back, receive() is triggered.
///         5. receive() immediately calls refundAfterTimeout() again,
///            attempting a classic reentrancy double-withdrawal.
///
///         Why the attack fails (defence-in-depth):
///         Layer 1 — CEI pattern: currentState is set to REFUNDED and
///                   amount is zeroed *before* the external call, so any
///                   re-entrant call sees the wrong state and reverts on
///                   the inState(AWAITING_DELIVERY) guard.
///         Layer 2 — nonReentrant: OpenZeppelin's mutex is still locked
///                   during the external call, so even if CEI were
///                   accidentally removed, this guard would still revert.
///
///         The attacker uses try/catch in receive() so that the failed
///         inner call does not bubble up and revert the outer refund.
///         This simulates a *sophisticated* attacker who knows how to
///         avoid tripping a naive success-check.  Both defences still win.
contract MaliciousReceiver {

    /// @notice The Escrow instance this contract acts as buyer for.
    Escrow public escrow;

    /// @notice Number of times receive() attempted a reentrant call.
    uint256 public reentrancyAttempts;

    /// @notice Whether the attack mode is active (set just before the attack).
    bool public attackEnabled;

    /// @notice Deploy a fresh Escrow with this contract as the buyer.
    /// @param _seller         Payable address of the seller.
    /// @param _arbiters       Three arbiter addresses for 2-of-3 voting.
    /// @param _deliveryPeriod Seconds until the delivery deadline.
    constructor(
        address payable _seller,
        address[3] memory _arbiters,
        uint256 _deliveryPeriod
    ) {
        // msg.sender here is the test deployer, but the Escrow's buyer will
        // be THIS contract (address(this)), because Escrow sets buyer = msg.sender.
        escrow = new Escrow(_seller, _arbiters, _deliveryPeriod, 0);
    }

    /// @notice Send ETH into the escrow (called by the test with value).
    function depositToEscrow() external payable {
        escrow.deposit{value: msg.value}();
    }

    /// @notice Enable attack mode and trigger the refund — entry point for the test.
    function attack() external {
        attackEnabled = true;
        // This call will trigger receive() mid-execution via the ETH transfer
        escrow.refundAfterTimeout();
    }

    /// @notice Fallback that fires when the Escrow sends ETH back.
    ///         A real attacker places the reentrant call here.
    receive() external payable {
        if (attackEnabled) {
            reentrancyAttempts++;
            // Sophisticated attacker uses try/catch to avoid reverting the
            // outer refund — they want the first withdrawal to succeed and
            // hope the second one does too.
            try escrow.refundAfterTimeout() {
                // Reaching here would mean double-withdrawal succeeded — CRITICAL BUG
                // (This branch should NEVER execute if the contract is correct.)
            } catch {
                // Expected path: CEI + nonReentrant correctly blocked the attack.
            }
        }
    }
}
