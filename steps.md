# Smart Contract Fund Escrow — Development Phases & Strict Evaluator Notes

> **Module:** EC8204 Blockchain and Cyber Security — University of Ruhuna, Faculty of Engineering
> **Deadline:** 31 September 2026 | **Presentation:** 3 minutes | **Max group size:** 4

---

## ⚖️ Strict Evaluator Assessment of Current Project State

### What Is Already Done (Solid Foundation)

| Component | Status | Quality |
|---|---|---|
| `Escrow.sol` smart contract | ✅ Complete | Good — state machine, 5 events, OZ ReentrancyGuard |
| `Escrow.test.js` test suite | ✅ Complete | 16 test cases, all major paths covered |
| `deploy.js` deployment script | ✅ Complete | Env-var configurable |
| `frontend/index.html` demo UI | ✅ Complete | Decent dark-theme UI using ethers.js v6 |
| README / documentation | ✅ Complete | Well-structured, security table present |

### Critical Gaps That Will Cost Marks (Evaluator's Red Flags)

> **⚠️ CAUTION: These gaps are what separates a B-grade from a full-marks project. Address ALL of them.**

1. **No public testnet deployment** — Running only on a local Hardhat node looks like it was never tested on real infrastructure. Sepolia deployment with Etherscan proof is expected at final-year level.
2. **No code coverage report** — Saying "16 tests pass" is weak. A coverage report showing **>95% branch coverage** is hard evidence of thoroughness.
3. **No gas analysis** — For a Blockchain module, showing gas costs per function is essential. It proves you understand on-chain economics.
4. **Frontend is a single HTML file with zero state management** — It doesn't listen to contract events (no `ethers.on(...)`), has no real-time balance displays, and has no loading/error states beyond a log div.
5. **No slither / static analysis** — For the "Cyber Security" half of this module, automated vulnerability scanning output (even a clean report) is strong proof.
6. **`raiseDispute()` has no access modifier** — The `require(msg.sender == buyer || msg.sender == seller)` is inside the function body, not a reusable modifier. Evaluators will catch this code smell.
7. **Single arbiter = centralization risk** — Mentioned in README as "future work" but not implemented. A 2-of-3 multi-arbiter vote would significantly elevate the project.
8. **No partial payment / fee mechanism** — A real escrow charges an arbiter fee. The contract is binary: 100% to seller or 100% refund to buyer.
9. **No presentation slides** — The deadline requires a `.ppt` file named `GP_XX_Fund_Escrow.pptx`. This is a graded deliverable. Zero marks without it.
10. **No `.env` / testnet config wired up** — `hardhat.config.js` has the Sepolia block commented out, not actually configured.

---

## 🗺️ Development Phases — Full Marks Roadmap

Each phase builds on the previous. Complete **all 6 phases** before the deadline.

---

### Phase 1 — Code Quality & Security Hardening

**Goal:** Make the Solidity contract production-grade and pass a strict code review.
**Estimated time:** 3–4 hours

#### 1.1 Refactor `raiseDispute()` into a Proper Modifier

Extract the `require(msg.sender == buyer || msg.sender == seller)` into a named modifier `onlyParty()` and apply it to `raiseDispute()`. This removes implicit access control from function bodies (a bad pattern):

```solidity
modifier onlyParty() {
    require(
        msg.sender == buyer || msg.sender == seller,
        "Escrow: only buyer or seller may call this"
    );
    _;
}

function raiseDispute() external onlyParty inState(State.AWAITING_DELIVERY) {
    currentState = State.DISPUTED;
    emit DisputeRaised(msg.sender);
}
```

#### 1.2 Add Arbiter Fee Mechanism (Partial Payout)

Add `uint256 public arbiterFeeBps` (basis points, e.g. 200 = 2%) to the constructor. In `resolveDispute()`, calculate `fee = payout * arbiterFeeBps / 10000`, send fee to arbiter, remainder to winner. Cap fee at 10% (1000 bps) to prevent griefing. Add an `ArbiterFeePaid(address indexed arbiter, uint256 fee)` event. This transforms the contract from a toy to a realistic economic model.

#### 1.3 Multi-Arbiter / 2-of-3 Vote (Advanced — High Marks)

Replace single `arbiter` with `address[3] public arbiters` and `mapping(address => bool) public hasVoted`. Track `uint8 votesForSeller` and `uint8 votesForBuyer`. Resolution triggers automatically when either counter reaches 2. This eliminates the "single arbiter = trusted middleman" centralization critique.

#### 1.4 NatSpec Documentation on All Functions

Every `external`/`public` function must have `@notice`, `@dev`, `@param`, `@return` tags:

```bash
npm install --save-dev hardhat-docgen
npx hardhat docgen
```

Include the generated HTML docs as a reference in your presentation.

#### 1.5 Run Slither Static Analysis

```bash
pip install slither-analyzer
slither contracts/Escrow.sol --solc-remaps "@openzeppelin=node_modules/@openzeppelin"
```

Fix any HIGH or MEDIUM severity findings. Screenshot the clean Slither output. Even a report showing 0 high/medium issues is powerful proof of security rigour.

---

### Phase 2 — Comprehensive Testing & Coverage

**Goal:** Achieve >95% branch coverage and add edge-case and attack simulation tests.
**Estimated time:** 4–5 hours

#### 2.1 Add Missing Test Cases

Current gaps in the test suite:

| Missing Test | Why It Matters |
|---|---|
| Arbiter cannot call `deposit()` | Proves access control is exhaustive |
| `confirmDelivery()` after deadline passes | State machine completeness |
| `resolveDispute()` emits correct event args | Event correctness verification |
| `refundAfterTimeout()` blocked in DISPUTED state | Cross-state protection |
| Reentrancy attack simulation | Security proof — use a malicious contract |
| Fee calculation correctness (if Phase 1.2 done) | Economic model proof |
| Multi-arbiter 2-of-3 vote sequence (if Phase 1.3 done) | Advanced feature testing |

#### 2.2 Add a Reentrancy Attack Simulation Test

Create `test/ReentrancyAttack.test.js`. Deploy a malicious contract whose `receive()` function re-enters `confirmDelivery()` recursively. Prove the `nonReentrant` modifier blocks the attack. This is the strongest possible proof for the Cyber Security half of this module. Evaluators love seeing an actual attack being blocked.

#### 2.3 Run Coverage and Export Report

```bash
npm install --save-dev solidity-coverage
npx hardhat coverage
```

Open `coverage/index.html` — screenshot showing **≥95% statements, branches, functions**. Add `require("solidity-coverage")` to your `hardhat.config.js`. Include the coverage screenshot in your presentation.

#### 2.4 Gas Report

In `hardhat.config.js`, add to the exports:

```javascript
gasReporter: {
  enabled: true,
  currency: "USD",
  coinmarketcap: "YOUR_FREE_API_KEY", // optional USD pricing
}
```

Then run `npx hardhat test`. Screenshot the gas report table — shows `deposit()`, `confirmDelivery()`, `resolveDispute()` costs per call. Present this as the "on-chain economics" section.

---

### Phase 3 — Public Testnet Deployment (Sepolia)

**Goal:** Deploy to a real public blockchain and get an Etherscan-verified contract.
**Estimated time:** 2–3 hours

#### 3.1 Set Up Environment Variables

Create `.env` in project root (never commit this — it is already in `.gitignore`):

```
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_ALCHEMY_KEY
PRIVATE_KEY=0xYOUR_TEST_WALLET_PRIVATE_KEY
ETHERSCAN_API_KEY=YOUR_ETHERSCAN_API_KEY
```

Get free keys from:
- **Alchemy RPC:** https://alchemy.com → create app → Ethereum → Sepolia
- **Etherscan API key:** https://etherscan.io/myapikey (free tier)
- **Sepolia ETH faucet:** https://sepoliafaucet.com or https://faucets.chain.link

#### 3.2 Update `hardhat.config.js`

```javascript
require("dotenv").config();
require("@nomicfoundation/hardhat-toolbox");

module.exports = {
  solidity: "0.8.20",
  networks: {
    localhost: { url: "http://127.0.0.1:8545" },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY,
  },
  gasReporter: {
    enabled: true,
    currency: "USD",
  },
};
```

#### 3.3 Deploy to Sepolia

```bash
npm install dotenv
npx hardhat run scripts/deploy.js --network sepolia
# Copy the deployed contract address from the terminal output
```

#### 3.4 Verify Contract Source Code on Etherscan

```bash
npx hardhat verify --network sepolia \
  DEPLOYED_ADDRESS \
  "SELLER_ADDRESS" "ARBITER_ADDRESS" "604800"
```

Navigate to `https://sepolia.etherscan.io/address/DEPLOYED_ADDRESS#code` and screenshot the **green verified tick** showing your source code is publicly visible. This is the single most impressive slide in a 3-minute presentation.

#### 3.5 Execute a Live Transaction on Sepolia

From MetaMask (with Sepolia network), perform the full happy path (deposit → confirmDelivery). Screenshot the transaction on Etherscan showing ETH transfer. Show the **Events tab** displaying `FundsDeposited` and `DeliveryConfirmed` — this proves your events work on a real chain.

---

### Phase 4 — Enhanced Frontend

**Goal:** Upgrade the frontend from a static demo to a reactive dApp.
**Estimated time:** 4–6 hours

#### 4.1 Add Real-Time Event Listeners

```javascript
// Wire up all 5 contract events for live UI updates
escrow.on("FundsDeposited", (buyer, amount, deadline) => {
  logLine(`FundsDeposited: ${ethers.formatEther(amount)} ETH locked`);
  refresh();
});
escrow.on("DeliveryConfirmed", (buyer, seller, amount) => {
  logLine(`Delivery confirmed — seller received ${ethers.formatEther(amount)} ETH`);
  refresh();
});
escrow.on("DisputeRaised", (raisedBy) => {
  logLine(`Dispute raised by ${raisedBy.slice(0, 8)}...`);
  refresh();
});
escrow.on("DisputeResolved", (arbiter, releaseToSeller, amount) => {
  logLine(`Dispute resolved — ${releaseToSeller ? "seller" : "buyer"} receives ${ethers.formatEther(amount)} ETH`);
  refresh();
});
escrow.on("RefundedAfterTimeout", (buyer, amount) => {
  logLine(`Timeout refund — ${ethers.formatEther(amount)} ETH back to buyer`);
  refresh();
});
```

The UI now updates live when someone else (on another browser tab) sends a transaction.

#### 4.2 Show Live Wallet Balances

Display buyer/seller/arbiter ETH balances that update after each transaction. Prove the ETH actually moved with a "Before / After" balance comparison — very impressive in a live demo.

#### 4.3 Add Role Auto-Detection

After connecting wallet, check `signer.getAddress()` against `buyer()`, `seller()`, `arbiter()` from the contract and auto-switch to the correct role tab. Gray out actions that are not valid for the current role or the current state.

#### 4.4 State-Aware Button Enabling

Use `currentState` to disable buttons that cannot be called in the current state:
- Disable "Deposit" once state ≠ AWAITING_PAYMENT
- Disable "Confirm Delivery" and "Raise Dispute" once state ≠ AWAITING_DELIVERY
- Disable "Resolve Dispute" once state ≠ DISPUTED

This shows you understand state machine UX and prevents confusing error messages.

#### 4.5 Add a State Diagram Visualizer

Below the vault card, render a CSS flow diagram:
`AWAITING_PAYMENT → AWAITING_DELIVERY → COMPLETE / DISPUTED → COMPLETE / REFUNDED`

Highlight the current state node in a bright accent colour. This is a great live visual for the presentation demo.

#### 4.6 Transaction History Table

Query past events using `escrow.queryFilter(...)` and display in a table showing: block number, timestamp, event type, amount, from → to. This demonstrates understanding of on-chain event querying beyond just listening to new events.

---

### Phase 5 — Security Analysis Report

**Goal:** Produce a written cyber-security analysis that directly earns marks for the Cyber Security half of the module.
**Estimated time:** 3–4 hours

Create a `SECURITY_ANALYSIS.md` document with the following sections:

#### 5.1 Attack Vector Analysis Table

| Attack | Severity | Vulnerability Without Mitigation | Mitigation Implemented | Proof |
|---|---|---|---|---|
| Reentrancy | Critical | Recursive ETH call drains contract before state update | CEI pattern + `nonReentrant` | `ReentrancyAttack.test.js` |
| Unauthorized Access | High | Anyone can release funds | `onlyBuyer/Seller/Arbiter` modifiers | Access control test suite |
| Integer Overflow | Medium | Pre-0.8.x: amount math could overflow | Solidity 0.8.20 built-in overflow checks | Compiler version |
| 2300 Gas Stipend DoS | Medium | `transfer()` fails if seller is a contract | `call{value: ...}` with success check | Code review |
| Funds Permanently Locked | Medium | Seller disappears, money stuck forever | `refundAfterTimeout()` | Timeout refund test |
| Front-running Arbiter Decision | Low | Arbiter sees pending tx, changes vote | Commit-reveal scheme (future work) | Discussed |
| 51% Attack | Low | Attacker rewrites chain history | Layer-1 consensus — out of scope | Theoretical analysis |
| Griefing via Forced Revert | Low | Sending to contract that reverts | `call` continues on failed receive | Code review |

#### 5.2 Threat Model Diagram

Draw a threat model showing actors (buyer, seller, arbiter, attacker), trust boundaries, and attack surfaces using a mermaid diagram. Include this in the slide deck.

#### 5.3 Formal Verification Note

The state machine is provably correct because all transitions are guarded by the `inState()` modifier. A state with no valid entry from another state is unreachable by construction — this is a formal safety property (reachability analysis).

---

### Phase 6 — Presentation Deck & Final Submission

**Goal:** Create a polished 3-minute presentation that earns full marks on the graded deliverable.
**Estimated time:** 3–4 hours

#### 6.1 File Naming (MANDATORY per instructions.md)

```
GP_XX_Fund_Escrow.pptx
```

Replace `XX` with your actual group number from the Google Sheet.

#### 6.2 Slide Structure (3 minutes = ~10 slides)

| Slide | Timing | Content |
|---|---|---|
| 1 — Title | 0:00 | Project name, group number, member names, module code EC8204 |
| 2 — The Problem | 0:15 | Trust gap in P2P trade, why PayPal/banks fail (fees, bias, slow) |
| 3 — Our Solution | 0:45 | State diagram, 3 roles (buyer/seller/arbiter), trustless = code-enforced |
| 4 — Architecture | 1:00 | Tech stack: Solidity + Hardhat + OpenZeppelin + ethers.js; Sepolia contract address |
| 5 — Live Demo: Happy Path | 1:10 | Screen-recorded or live: deposit → confirm delivery → balance changes |
| 6 — Live Demo: Dispute Flow | 1:40 | Screen-recorded or live: dispute raised → arbiter resolves |
| 7 — Security Analysis | 2:00 | Condensed attack table from SECURITY_ANALYSIS.md |
| 8 — Test Coverage & Gas | 2:20 | Screenshot of ≥95% coverage report + gas report table |
| 9 — Sepolia Etherscan | 2:30 | Verified contract green tick + transaction screenshot + Events tab |
| 10 — Limitations & Future Work | 2:45 | Multi-arbiter voting, oracle-fed delivery, commit-reveal, ZK proofs |

#### 6.3 Slide Design Rules

- Use a **dark background** (matching the frontend's `#11161d`) for visual consistency.
- Include the University of Ruhuna logo on slide 1.
- Every code snippet must use a monospace font with syntax highlighting.
- The state diagram (AWAITING_PAYMENT → ... → COMPLETE) must appear on at least one slide.
- Screenshots of Etherscan, test output, and coverage must be **actual screenshots**, not mockups.

#### 6.4 ELMS Submission Checklist

- [ ] Slide file named exactly `GP_XX_Fund_Escrow.pptx`
- [ ] Only **one submission per group** (last before deadline counts)
- [ ] Submit on ELMS **before 31 September 2026**
- [ ] Group number registered on the Google Sheet

---

## 📋 Full Marks Checklist (Use This Before Submission)

### Smart Contract Quality
- [ ] `raiseDispute()` uses a named `onlyParty` modifier
- [ ] Arbiter fee mechanism implemented (Phase 1.2)
- [ ] All 5 events emit correct indexed arguments
- [ ] All functions have complete NatSpec comments
- [ ] Constructor validates all three address pairs for conflict
- [ ] State machine is complete and all transitions are guarded

### Testing & Security
- [ ] All 16+ original tests pass (`npx hardhat test`)
- [ ] Reentrancy attack simulation test passes (contract is immune)
- [ ] Slither shows 0 HIGH / 0 MEDIUM severity issues
- [ ] Coverage report shows ≥95% statements and ≥90% branch coverage
- [ ] Gas report generated and screenshots taken

### Deployment
- [ ] Compiled: `npx hardhat compile`
- [ ] Deployed to local Hardhat node: `npx hardhat node` + `npm run deploy:local`
- [ ] Deployed to Sepolia testnet with `--network sepolia`
- [ ] Contract source code verified on Sepolia Etherscan (green tick visible)
- [ ] At least one real transaction executed on Sepolia (Etherscan link ready)

### Frontend
- [ ] Event listeners wired (real-time updates across browser tabs)
- [ ] Role auto-detection from connected wallet address
- [ ] State-aware button enabling/disabling
- [ ] Live ETH balance display (before/after transaction)
- [ ] State diagram visualizer showing current state
- [ ] Transaction history table from `queryFilter()`

### Presentation
- [ ] File named `GP_XX_Fund_Escrow.pptx` with correct group number
- [ ] 10 slides covering all sections in the table above
- [ ] Sepolia Etherscan screenshot with green verified tick
- [ ] Coverage screenshot showing ≥95%
- [ ] Slither clean output screenshot
- [ ] Live demo rehearsed and fits within 3 minutes

---

## 🔧 Quick Command Reference

```bash
# Install all dependencies
npm install

# Install additional tools for advanced phases
npm install --save-dev solidity-coverage hardhat-docgen dotenv

# Compile the contract
npx hardhat compile

# Run all tests
npx hardhat test

# Run tests with gas report
REPORT_GAS=true npx hardhat test

# Run coverage report (generates coverage/index.html)
npx hardhat coverage

# Start local Hardhat node (Terminal 1)
npx hardhat node

# Deploy to local node (Terminal 2)
npm run deploy:local

# Deploy to Sepolia testnet
npx hardhat run scripts/deploy.js --network sepolia

# Verify source code on Etherscan
npx hardhat verify --network sepolia <ADDRESS> "<SELLER>" "<ARBITER>" "<PERIOD_SECONDS>"

# Run Slither static analysis (requires Python)
pip install slither-analyzer
slither contracts/Escrow.sol --solc-remaps "@openzeppelin=node_modules/@openzeppelin"
```

---

## 🏆 Mark Allocation Estimate (Evaluator's View)

| Category | Max Marks | Current State | After All Phases |
|---|---|---|---|
| Blockchain problem identification & motivation | 15% | 12% ✅ | 15% |
| Smart contract correctness & implementation | 25% | 18% ⚠️ | 24% |
| Cyber security analysis & hardening | 25% | 14% ❌ | 24% |
| Testing & verification quality | 15% | 8% ❌ | 15% |
| Presentation quality & live demo | 20% | 0% ❌ (no slides yet) | 19% |
| **TOTAL** | **100%** | **~52%** | **~97%** |

> **IMPORTANT:** The biggest single mark gain is **Phase 3 (Sepolia + Etherscan)** and **Phase 6 (presentation slides)**. These two together move you from a borderline pass to near-full marks. Do not skip either.

---

## ⏱️ Prioritised Action Plan (If Time Is Short)

Complete phases in this priority order when the deadline is close:

1. **Phase 6 first** — Slides are a graded deliverable. Zero marks without a `.pptx` file submitted to ELMS.
2. **Phase 3** — Sepolia + Etherscan is the highest-impact single technical proof.
3. **Phase 2.3** — Coverage report is a quick win (< 30 min) that massively impresses evaluators.
4. **Phase 1.1 & 1.2** — Code quality refactors take 1–2 hours and show engineering maturity.
5. **Phase 4** — Enhanced frontend makes the live demo segment unforgettable.
6. **Phase 5** — Written security analysis ties the Cyber Security marks directly to your code.
