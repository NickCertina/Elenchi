# Contract Verification & Deployment Guide

## 1. Compiler & EVM Settings

`contracts/src/ElenchiArena.sol` is pinned for deterministic compilation and Sourcify `exact_match` verification:

- **Solidity Compiler:** `0.8.28` (`pragma solidity ^0.8.24`)
- **Optimizer:** Enabled (`runs = 200`, `viaIR = false`)
- **EVM Version:** `cancun`
- **Bytecode Metadata Hash:** `ipfs` (preserved in CBOR metadata for Sourcify `exact_match`)

## 2. Deployment Order (Requires Explicit Operator Approval)

1. **Robinhood Chain Testnet (`chainId = 46630`)**
   - RPC: `https://rpc.testnet.chain.robinhood.com`
   - Explorer: `https://explorer.testnet.chain.robinhood.com`
   - Deploy via Foundry:
     ```bash
     cd contracts
     forge script script/DeployElenchiArena.s.sol:DeployElenchiArena \
       --rpc-url https://rpc.testnet.chain.robinhood.com \
       --broadcast
     ```
2. **Sourcify & Blockscout Verification**
   - Submit `contracts/src/ElenchiArena.sol` and standard JSON input to Sourcify (`chainId = 46630`, then `4663` after Mainnet approval) so Blockscout displays verified source with `exact_match`.
3. **Robinhood Chain Mainnet (`chainId = 4663`)**
   - RPC: `https://rpc.mainnet.chain.robinhood.com`
   - Explorer: `https://robinhoodchain.blockscout.com`
   - Deploy only after Testnet attestation registration, replay rejection, and Sourcify verification are confirmed.
