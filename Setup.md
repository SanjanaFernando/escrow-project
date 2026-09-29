# Escrow Project Setup and Wallet Connection

This guide explains how to install, test, deploy, and run the local browser demo on Windows.

The commands below must be run from the project root:

```text
C:\Ruhuna Eng\Semester 8\EC8204 Blockchain and Cyber Security\Project\escrow-project
```

## 1. Prerequisites

Install the following before starting:

- Node.js 18 or newer: https://nodejs.org/
- MetaMask browser extension: https://metamask.io/download/
- A Chromium-based browser such as Chrome or Edge

Check Node.js and npm in PowerShell:

```powershell
node --version
npm --version
```

## 2. Open the project

In PowerShell, run:

```powershell
cd "C:\Ruhuna Eng\Semester 8\EC8204 Blockchain and Cyber Security\Project\escrow-project"
```

Install the project dependencies once:

```powershell
npm install
```

## 3. Compile and test

Compile the Solidity contracts:

```powershell
npm run compile
```

Run the automated tests:

```powershell
npm test
```

Run the complete end-to-end proof script, if required:

```powershell
npx hardhat run scripts/run-all-proofs.js
```

The proof script uses Hardhat's temporary in-memory blockchain. It does not deploy the contract used by the browser frontend.

## 4. Start the local blockchain

Open **Terminal 1** in the project root and run:

```powershell
npm run node
```

Keep this terminal open. It starts a local Ethereum network at:

```text
RPC URL: http://127.0.0.1:8545
Chain ID: 31337
Currency: ETH
```

The terminal prints pre-funded test accounts and their private keys. These accounts are for local testing only.

If `npm run node` exits with an error saying that port `8545` is already in use, a Hardhat node is probably already running. Keep the existing node running and do not start a second one.

If the existing node is not needed, find and stop the process using port 8545, then start the node again:

```powershell
Get-NetTCPConnection -LocalPort 8545 -ErrorAction SilentlyContinue
```

Do not use `Stop-Process` unless you have confirmed the process is the old Hardhat node.

## 5. Import local accounts into MetaMask

Only import accounts from the output of the local `npm run node` command.

1. Copy the **Private Key** for one account from Terminal 1. Copy the private key, not only the public address.
2. Open MetaMask.
3. Open the account menu.
4. Select **Add account or hardware wallet**.
5. Select **Import account**.
6. Paste the private key and select **Import**.
7. Repeat with different test accounts for the buyer, seller, and arbiters.

Never use these local private keys on a real network or with real funds.

## 6. Add the Hardhat Local network to MetaMask

In MetaMask, open the network selector and add a custom network with these values:

```text
Network name: Hardhat Local
New RPC URL: http://127.0.0.1:8545
Chain ID: 31337
Currency symbol: ETH
```

Select **Hardhat Local** before using the frontend.

## 7. Deploy the contract

Open **Terminal 2** in the project root. Leave Terminal 1 running, then run:

```powershell
npm run deploy:local
```

The command prints a line similar to:

```text
Escrow deployed to: 0x...
```

Copy the address after `Escrow deployed to:`. The deploy script uses these local roles by default:

```text
Buyer:     account 0
Seller:    account 1
Arbiter 1: account 2
Arbiter 2: account 3
Arbiter 3: account 4
```

Keep Terminal 1 running. If the Hardhat node is stopped and restarted, the local blockchain is reset and the old contract address is no longer valid. Deploy again and use the new address.

## 8. Start the frontend

Open **Terminal 3** in the project root and run:

```powershell
npx serve frontend -l 3000
```

Open this address in the browser:

```text
http://localhost:3000
```

If `npx serve frontend -l 3000` exits with an error, try the alternative static server:

```powershell
npx http-server frontend -p 3000
```

Keep the frontend terminal open while using the page.

## 9. Connect the wallet

1. Open `http://localhost:3000`.
2. Confirm MetaMask is unlocked.
3. Select the **Hardhat Local** network.
4. Select the imported buyer account, which is account 0 unless you deployed with custom environment variables.
5. Click **Connect Wallet** on the page.
6. Approve the connection request in MetaMask.
7. Paste the contract address printed by `npm run deploy:local` into **Deployed contract address**.
8. Click **Load Contract**.

The page should display the buyer, seller, three arbiters, fee, deadline, and current escrow state.

If the page displays a network warning, click **Switch to Hardhat Local (31337)** and approve the MetaMask request.

## 10. Demonstrate the normal escrow flow

Use the account roles assigned by the deployment script:

1. With the buyer account selected, choose the **Buyer** tab.
2. Enter an amount such as `1.0` ETH.
3. Click **Deposit Funds** and approve the transaction.
4. After the state changes to `Awaiting Delivery`, click **Confirm Delivery**.
5. Approve the transaction. The seller receives the escrowed funds.

To change roles, select another imported account in MetaMask and refresh or reconnect the page:

- Account 1: seller
- Accounts 2, 3, and 4: arbiters

For a dispute demonstration, deposit funds as the buyer, raise a dispute as the buyer or seller, then switch to at least two arbiter accounts and vote. A 2-of-3 arbiter majority resolves the dispute.
