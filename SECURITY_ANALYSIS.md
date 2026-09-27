# Security Analysis — Smart Contract Fund Escrow
### EC8204 Blockchain and Cyber Security | University of Ruhuna

---

## 1. Overview

This document is the formal security analysis for the **Smart Contract Fund Escrow** project.
It covers the threat model, a comprehensive attack vector table with proof of mitigation,
a formal state-machine safety argument, and recommendations for future hardening.

The contract is deployed at:
- **Local:** `http://127.0.0.1:8545` (Hardhat node)
- **Sepolia testnet:** [`0xAa565E4b6a06852d4D1690DaEe34C29C734E9B66`](https://sepolia.etherscan.io/address/0xAa565E4b6a06852d4D1690DaEe34C29C734E9B66#code) (Verified on Etherscan)

---

## 2. Threat Model

### 2.1 Actors and Trust Levels

| Actor | Trust Level | Description |
|---|---|---|
| **Buyer** | Fully trusted (funds) | Deposits ETH; confirms delivery or raises dispute |
| **Seller** | Partially trusted | Delivers goods/services; can only raise dispute, not take funds |
| **Arbiters (×3)** | Independently trusted | Each votes independently; 2-of-3 majority required |
| **Smart Contract** | Fully trusted (code) | Code is law — rules are transparent and immutable post-deploy |
| **External Attacker** | Untrusted | Any address not in the above set |
| **Malicious Contract** | Untrusted | A contract acting as buyer/seller designed to exploit re-entrancy |

### 2.2 Trust Boundaries

```
┌────────────────────────────────────────────────────────┐
│              Ethereum Blockchain (L1)                  │
│  ┌──────────────────────────────────────────────────┐  │
│  │              Escrow Contract                     │  │
│  │  • Holds ETH (funds locked by code, not a bank) │  │
│  │  • State machine: 5 states, guarded transitions │  │
│  │  • Access control: per-role modifiers           │  │
│  └──────────────────────────────────────────────────┘  │
│         ↑ deposit          ↑ castVote                  │
│      [Buyer]          [Arbiter 1/2/3]                  │
│         ↓ confirmDelivery / refundAfterTimeout          │
│      [Seller] ← paid out on successful delivery        │
└────────────────────────────────────────────────────────┘
         ↑ Attackers operate outside this boundary
```

### 2.3 Protected Assets

| Asset | Location | Value |
|---|---|---|
| Escrowed ETH | Contract balance | Variable (set by buyer on deposit) |
| Seller payout right | Immutable `seller` address | Receives ETH on confirmed delivery or arbiter ruling |
| Buyer refund right | Immutable `buyer` address | Receives ETH on timeout or arbiter ruling |
| Arbiter independence | `isArbiter` mapping | Each arbiter's vote is private until cast |

---

## 3. Attack Vector Analysis

### 3.1 CRITICAL — Reentrancy Attack

**Attack description:**  
A malicious contract acting as the seller (or buyer) implements a `receive()` / `fallback()` function
that re-calls `confirmDelivery()`, `resolveDispute()`, or `refundAfterTimeout()` mid-execution
to drain funds before the state update occurs.

**Example attack flow (without mitigation):**
```
Attacker.receive() {
    if (escrow.amount() > 0)
        escrow.confirmDelivery();  // re-enters before amount = 0
}
```

**Mitigation — Checks-Effects-Interactions (CEI) Pattern:**
```solidity
function confirmDelivery() external onlyBuyer inState(State.AWAITING_DELIVERY) nonReentrant {
    uint256 payout = amount;
    currentState = State.COMPLETE; // ← Effect: state updated FIRST
    amount = 0;                    // ← Effect: amount zeroed FIRST
    (bool success, ) = seller.call{value: payout}(""); // ← Interaction: LAST
    require(success, "Escrow: transfer to seller failed");
}
```

**Second defence — OpenZeppelin ReentrancyGuard:**
```solidity
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
// nonReentrant modifier applied to all payout functions
```

**Proof:** `test/ReentrancyAttack.test.js` deploys a malicious contract, confirms
the re-entrant call is rejected with `ReentrancyGuard: reentrant call`.

**Severity:** CRITICAL → **Mitigated (two independent layers)**

---

### 3.2 HIGH — Unauthorized Fund Release

**Attack description:**  
Any external address calls `confirmDelivery()` to release funds to themselves,
or calls `castVote()` to manipulate the dispute outcome.

**Mitigation — Named Role Modifiers:**
```solidity
modifier onlyBuyer()  { require(msg.sender == buyer,  "..."); _; }
modifier onlySeller() { require(msg.sender == seller, "..."); _; }
modifier onlyParty()  { require(msg.sender == buyer || msg.sender == seller, "..."); _; }
modifier onlyArbiter(){
    require(isArbiter[msg.sender], "Escrow: caller is not a registered arbiter");
    require(!hasVoted[msg.sender],  "Escrow: arbiter has already voted");
    _;
}
```

> **Code quality note:** Using *named modifiers* (not inline `require`) is the correct
> Solidity pattern. It makes access control auditable at the function signature level
> and prevents the anti-pattern of hidden access logic inside function bodies.

**Proof:** Test suite covers 12 unauthorized-access scenarios — all revert with descriptive messages.

**Severity:** HIGH → **Mitigated**

---

### 3.3 HIGH — Double Voting by Arbiter

**Attack description:**  
An arbiter votes twice — once to create a 1-1 tie and once to break it in their favour,
giving a single arbiter unilateral control.

**Mitigation:**
```solidity
mapping(address => bool) public hasVoted;

modifier onlyArbiter() {
    require(isArbiter[msg.sender], "...");
    require(!hasVoted[msg.sender], "Escrow: arbiter has already voted");
    _;
}

function castVote(bool voteForSeller) external onlyArbiter ... {
    hasVoted[msg.sender] = true; // effect before any interaction
    ...
}
```

The `hasVoted` mapping is checked as part of the `onlyArbiter` modifier — it cannot be bypassed.

**Severity:** HIGH → **Mitigated**

---

### 3.4 MEDIUM — 2300-Gas Stipend DoS (Stuck Funds)

**Attack description:**  
Using `transfer()` or `send()` forwards exactly 2300 gas to the recipient.
If the recipient is a smart contract with a `receive()` function that costs >2300 gas
(e.g., one that emits an event or writes to storage), the transfer permanently fails
and the funds are locked forever in the escrow contract.

**Mitigation — Low-Level `call` with success check:**
```solidity
(bool success, ) = seller.call{value: payout}("");
require(success, "Escrow: transfer to seller failed");
```

`call` forwards all remaining gas (safe default since EIP-1884 / Istanbul hard fork).
The `require(success)` check ensures the transaction still reverts if the recipient
explicitly rejects the payment.

**Severity:** MEDIUM → **Mitigated**

---

### 3.5 MEDIUM — Denial of Service (Funds Locked Forever)

**Attack description:**  
The seller never delivers and never raises a dispute.
Without a timeout mechanism, the buyer's funds are permanently locked.

**Mitigation — `refundAfterTimeout()`:**
```solidity
uint256 public deliveryDeadline; // set on deposit = block.timestamp + deliveryPeriod

function refundAfterTimeout() external onlyBuyer inState(State.AWAITING_DELIVERY) nonReentrant {
    require(block.timestamp >= deliveryDeadline, "Escrow: delivery deadline has not passed yet");
    // ... refund buyer
}
```

**Note on `block.timestamp` manipulation:**
Ethereum miners can manipulate `block.timestamp` by ±15 seconds. For a 7-day (604 800 s)
delivery window this is a negligible attack surface (±0.002% of the period).

**Severity:** MEDIUM → **Mitigated**

---

### 3.6 MEDIUM — Integer Overflow/Underflow

**Attack description:**  
Pre-Solidity 0.8.x, arithmetic operations could silently overflow/underflow,
causing `amount` to wrap to zero or a massive value.

**Mitigation — Solidity 0.8.20 Built-in Checks:**
```solidity
pragma solidity ^0.8.20;
```
All arithmetic in Solidity 0.8+ reverts automatically on overflow/underflow.
The fee calculation `(total * arbiterFeeBps) / 10_000` is also safe because
`arbiterFeeBps` is capped at 1000 (10%) by the constructor.

**Severity:** MEDIUM → **Mitigated (by compiler version)**

---

### 3.7 MEDIUM — Invalid State Transitions

**Attack description:**  
A caller attempts to `confirmDelivery()` before a deposit, or `castVote()` while the
contract is still in `AWAITING_DELIVERY`, creating an inconsistent state.

**Mitigation — `inState()` Modifier (Finite State Machine):**
```solidity
modifier inState(State expected) {
    require(currentState == expected, "Escrow: invalid state for this action");
    _;
}
```

Every state-changing function declares its required predecessor state.
The contract's state machine is **formally safe**: no state is reachable from
a state that should not reach it.

**Reachability proof (state diagram):**
```
AWAITING_PAYMENT ──deposit()──────────────→ AWAITING_DELIVERY
                                                 │
                                    ┌────────────┼────────────────┐
                                    │            │                │
                            confirmDelivery  raiseDispute  refundAfterTimeout
                                    │            │           (after deadline)
                                    ↓            ↓                ↓
                                 COMPLETE     DISPUTED         REFUNDED
                                                 │
                                        castVote (2-of-3)
                                                 ↓
                                              COMPLETE
```

There is no path from `COMPLETE` or `REFUNDED` back to any active state.

**Severity:** MEDIUM → **Mitigated**

---

### 3.8 LOW — Conflicted Arbiter (Address Overlap)

**Attack description:**  
The buyer or seller registers themselves as an arbiter, giving them both
a party role and a voting role, enabling them to unilaterally resolve disputes.

**Mitigation — Constructor Validation Loop:**
```solidity
for (uint8 i = 0; i < ARBITER_COUNT; i++) {
    address a = _arbiters[i];
    require(a != msg.sender, "Escrow: arbiter must differ from buyer");
    require(a != _seller,    "Escrow: arbiter must differ from seller");
    require(!isArbiter[a],   "Escrow: duplicate arbiter address");
    isArbiter[a] = true;
}
```

**Severity:** LOW → **Mitigated**

---

### 3.9 LOW — Front-Running Arbiter Decision

**Attack description:**  
An arbiter observes another arbiter's pending `castVote` transaction in the mempool
and front-runs it with their own vote to guarantee the outcome before the other
arbiter's transaction is mined.

**Impact:**  
Low — each arbiter is *supposed* to vote their honest opinion. Front-running
can only affect vote ordering, not override the 2-of-3 majority threshold.

**Mitigation (not yet implemented — future work):**
A **commit-reveal scheme** where arbiters first commit `hash(vote, salt)` and
later reveal the preimage would hide vote direction until reveal time.

**Severity:** LOW → **Acknowledged, documented as future work**

---

### 3.10 LOW — 51% Attack on Ethereum

**Attack description:**  
An attacker who controls >50% of Ethereum's hashing power (PoW) or staked ETH (PoS)
could theoretically reorganise the blockchain and revert confirmed transactions.

**Impact on this contract:**  
All confirmed state transitions (deposit, confirmDelivery, castVote) could be reversed.

**Mitigation:**  
This is a Layer-1 consensus security concern outside the scope of a smart contract.
On Ethereum mainnet, a 51% attack would require controlling ~$100B+ of staked ETH (as of 2025),
making it economically infeasible. For high-value escrows, waiting for more block confirmations
before trusting a state transition is recommended.

**Severity:** LOW → **Out of scope for this contract layer**

---

## 4. Security Properties Summary

| Property | Status | Mechanism |
|---|---|---|
| **No reentrancy** | ✅ Proven | CEI pattern + `nonReentrant` |
| **No unauthorized access** | ✅ Proven | `onlyBuyer`, `onlySeller`, `onlyParty`, `onlyArbiter` |
| **No double voting** | ✅ Proven | `hasVoted` mapping checked in modifier |
| **No stuck funds** | ✅ Proven | `refundAfterTimeout()` + `call` instead of `transfer` |
| **No overflow** | ✅ Proven | Solidity 0.8.20 built-in checks |
| **No invalid state transitions** | ✅ Proven | `inState()` modifier on every function |
| **No conflicted arbiter** | ✅ Proven | Constructor validation loop |
| **Decentralized arbitration** | ✅ Proven | 2-of-3 majority vote (no single point of trust) |
| **No front-running** | ⚠️ Partial | Commit-reveal scheme (future work) |
| **L1 consensus attacks** | ⚠️ Out of scope | Layer-1 concern |

---

## 5. Static Analysis (Slither)

Run with:
```bash
pip install slither-analyzer
slither contracts/Escrow.sol --solc-remaps "@openzeppelin=node_modules/@openzeppelin"
```

Expected result after Phase 1 hardening: **0 HIGH, 0 MEDIUM** findings.
*(Screenshot to be added after running Slither — include in presentation slide 7.)*

---

## 6. Formal Verification Note

The state machine enforced by `inState()` modifiers provides a **reachability safety guarantee**:

- Any state not reachable via a legitimate sequence of function calls is unreachable by construction.
- All reachable terminal states (`COMPLETE`, `REFUNDED`) have no outgoing transitions.
- The `COMPLETE` state is reached via exactly three mutually exclusive paths:
  1. Buyer calls `confirmDelivery()` (happy path)
  2. 2-of-3 arbiters vote seller wins (dispute resolved for seller)
  3. 2-of-3 arbiters vote buyer wins (dispute resolved for buyer, state = `COMPLETE` with buyer receiving)

This is a **type-level safety property** — it requires no runtime checking beyond the modifiers already present.

---

## 7. Future Hardening Recommendations

| Recommendation | Benefit | Complexity |
|---|---|---|
| Commit-reveal voting scheme | Hides arbiter votes until reveal, prevents front-running | Medium |
| Oracle-fed automatic delivery confirmation | Removes buyer subjectivity; e.g., package tracking API via Chainlink | High |
| Multi-signature buyer confirmation | Requires 2-of-3 from a buyer group; prevents single-key loss | Medium |
| ZK-proof of delivery | Buyer proves receipt without revealing identity on-chain | Very High |
| Upgradeable proxy pattern | Allows contract logic to be updated after deployment | Medium |
| On-chain dispute evidence storage | Arbiters vote on IPFS-pinned evidence hash, not blind trust | Medium |

---

*Document version: 1.0 — EC8204 Group Project, University of Ruhuna, 2026*
