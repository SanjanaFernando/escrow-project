# Smart Contract Fund Escrow — EC8204 Group Project

A blockchain-based escrow system where a **buyer** deposits funds, a **seller**
delivers goods/services, and a neutral **arbiter** resolves disputes if the
two parties disagree. If the seller never delivers, the buyer can reclaim
funds after a deadline. Built with Solidity + Hardhat.

## 1. Why this counts as a strong "problem → blockchain solution" story

For your presentation, frame it like this:
- **Problem:** in online trade between strangers, whoever pays or ships first
  is at risk (pay-first buyer risks non-delivery; ship-first seller risks
  non-payment). Traditional escrow needs a trusted middleman (bank, PayPal)
  who takes a cut and can be corrupt, slow, or biased.
- **Blockchain solution:** a smart contract acts as the trustless middleman.
  Funds are locked in code, not in a company's bank account. Rules for
  releasing funds are transparent, auditable, and cannot be changed after
  deployment — no one (including the arbiter) can touch funds outside the
  contract's defined paths.
- **Cyber security angle:** the contract is explicitly hardened against
  reentrancy attacks, unauthorized access, and denial-of-service via stuck
  funds (see "Security Design" below) — ties directly into the module name.

## 2. Project structure

```
escrow-project/
├── contracts/
│   └── Escrow.sol          # the smart contract
├── test/
│   └── Escrow.test.js      # automated tests (16 test cases)
├── scripts/
│   └── deploy.js           # deployment script
├── frontend/
│   └── index.html          # demo UI (connects via MetaMask + ethers.js)
├── hardhat.config.js
├── package.json
└── README.md
```

## 3. Setup (do this once)

You need [Node.js](https://nodejs.org) (v18 or newer) installed.

```bash
cd escrow-project
npm install
```

This installs Hardhat, the Hardhat Toolbox (testing/deployment tools), and
OpenZeppelin Contracts (used for the `ReentrancyGuard` security module).

## 4. Compile the contract

```bash
npx hardhat compile
```

The first run downloads the Solidity compiler (needs internet access) —
this is normal and only happens once.

## 5. Run the automated tests

```bash
npx hardhat test
```

You should see all tests pass, covering: deployment validation, deposits,
the happy path (buyer confirms → seller paid), the dispute path (arbiter
resolves either way), access control (wrong caller rejected), and the
timeout refund path. **Screenshot this passing test output for your
presentation/report — it's strong evidence of correctness.**

## 6. Run a local blockchain and deploy

Open **two terminals**.

**Terminal 1** — start a local Ethereum node (simulates a blockchain with
20 pre-funded test accounts):
```bash
npx hardhat node
```
Leave this running. Copy a couple of the private keys/addresses it prints —
you'll use them as buyer/seller/arbiter in MetaMask for the live demo.

**Terminal 2** — deploy the contract to that local node:
```bash
npx hardhat run scripts/deploy.js --network localhost
```
This prints the deployed contract address. Copy it.

## 7. Demo it with the frontend

1. In MetaMask, add a custom network:
   - RPC URL: `http://127.0.0.1:8545`
   - Chain ID: `31337`
   - Currency symbol: `ETH`
2. Import a couple of the test account private keys from Terminal 1's
   output into MetaMask (one for "buyer", one for "seller", one for
   "arbiter" — use different browser profiles or switch accounts to
   role-play each party).
3. Open `frontend/index.html` directly in your browser (double-click it,
   or use a simple local server like `npx serve frontend`).
4. Click **Connect Wallet**, paste in the deployed contract address, click
   **Load Contract**.
5. As the buyer account: enter an ETH amount and click **Deposit Funds**.
6. Switch MetaMask to the buyer account and click **Confirm Delivery** to
   release funds to the seller — watch the seller's balance increase.
7. To show the dispute flow: deposit again, switch to seller and click
   **Raise Dispute**, then switch to the arbiter account and resolve it.

This live demo is what will make your 3-minute presentation memorable —
show real ETH balances changing on-screen rather than just slides.

## 8. (Optional, for extra credit) Deploy to a public testnet

Deploying to Sepolia testnet shows you can work with a "real" public
blockchain, not just a local simulation:

1. Get free Sepolia ETH from a faucet (e.g. search "Sepolia faucet").
2. Get a free RPC URL from [Alchemy](https://alchemy.com) or
   [Infura](https://infura.io).
3. Create a `.env` file (never commit this):
   ```
   SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
   PRIVATE_KEY=your_test_wallet_private_key
   ```
4. Install `dotenv`: `npm install dotenv` and add
   `require("dotenv").config();` to the top of `hardhat.config.js`.
5. Uncomment the `sepolia` network block in `hardhat.config.js`.
6. Deploy: `npx hardhat run scripts/deploy.js --network sepolia`
7. You can now view your contract on
   [Sepolia Etherscan](https://sepolia.etherscan.io) — screenshot this
   for your report, it's excellent proof of real deployment.

## 9. Security design (highlight this for marks — it's the "Cyber Security" half)

| Risk | Mitigation in this contract |
|---|---|
| **Reentrancy attack** (seller's contract re-enters `confirmDelivery` mid-transfer to drain funds) | State is updated *before* the external ETH transfer (Checks-Effects-Interactions pattern), plus OpenZeppelin's `nonReentrant` modifier as a second layer. |
| **Unauthorized access** (anyone releasing funds) | `onlyBuyer` / `onlySeller` / `onlyArbiter` modifiers restrict every state-changing function to the correct party. |
| **Funds permanently stuck** (seller address can't receive via `transfer`'s 2300 gas stipend) | Uses low-level `call{value: ...}` with a success check instead of `transfer`/`send`. |
| **Denial of service / griefing** (seller disappears, buyer's money locked forever) | `refundAfterTimeout()` lets the buyer reclaim funds once `deliveryDeadline` passes. |
| **Invalid state transitions** (e.g. depositing twice, confirming before depositing) | `inState()` modifier enforces a strict state machine: `AWAITING_PAYMENT → AWAITING_DELIVERY → COMPLETE/DISPUTED/REFUNDED`. |
| **Conflicted arbiter** | Constructor rejects an arbiter address equal to buyer or seller. |

You could extend this further (great "future work" slide) with: a
commit-reveal scheme so the arbiter can't front-run their own decision, an
oracle-fed automatic delivery confirmation, or a multi-arbiter voting
scheme instead of a single trusted arbiter.

## 10. Suggested 3-minute presentation structure

1. **0:00–0:30** — The problem: trust gap in peer-to-peer trade, why
   traditional escrow (banks, PayPal) has costs/limits.
2. **0:30–1:00** — The solution: smart contract escrow, the 3 roles, the
   state diagram (Awaiting Payment → Awaiting Delivery → Complete/Disputed/Refunded).
3. **1:00–2:15** — Live demo: deposit → confirm delivery (happy path), then
   a quick dispute → arbiter resolution.
4. **2:15–2:45** — Security design table (the slide above) — this is what
   distinguishes a "Cyber Security" module project from a plain blockchain
   demo.
5. **2:45–3:00** — Limitations & future work (single arbiter is a
   centralization point; gas costs; could add multi-sig arbitration).

Remember the submission naming rule from the brief:
`GP_XX_Task_name in short_name.ppt` (e.g. `GP_04_Fund_Escrow.pptx`).
