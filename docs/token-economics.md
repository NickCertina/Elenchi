# Token Economics & Fee Separation (`$ELENCHI`)

## 1. Authoritative Prelaunch Status

- **Current State:** `TOKEN_LAUNCH_STATE = PRELAUNCH` (`ELENCHI_TOKEN_ADDRESS = null`).
- **Launch Mechanism:** `$ELENCHI` will be launched manually by the project owner via the official Pons website (`https://ponsfamily.com/`) on Robinhood Chain Mainnet (`4663`).
- **Prohibited Actions:** Elenchi never deploys an ERC-20 token, mints tokens, creates liquidity pools, or automates launchpad transactions.

## 2. Pons Documentation Nuance & Fee Separation

Published Pons main documentation describes immediate token + WETH pool creation without a curve migration, whereas published Pons V2 documentation describes bonding curves, graduation, and configurable creator taxes. Exact parameters are recorded only from the actual Pons version and creation transaction used at manual launch.

Elenchi strictly separates six distinct fee/cost categories:

1. **Pons Platform / Base Swap Fee:** Controlled by Pons pool/curve contracts. Elenchi never collects or modifies swap fees.
2. **Optional Pons Creator Trading Tax:** Owner's proposed 3% creator tax is a launch-time UI configuration parameter to verify against the active Pons version before signing. If supported by the chosen Pons version, it applies to eligible DEX/curve trades — it must **never** be described as a generic wallet-to-wallet ERC-20 transfer tax unless verified on-chain.
3. **Temporary Opening Snipe Tax:** Version-dependent Pons launch protection window.
4. **Pons Launch / Gas Costs:** Paid in native ETH on Robinhood Chain (`4663`) by the owner's wallet during manual launch.
5. **Elenchi Arena Attestation Fee:** `0 ETH` for off-chain sandbox runs; optional capped Wei fee (`<= 0.01 ETH`) in `ElenchiArena.sol` for on-chain attestation registration.
6. **Elenchi Metered AI / API Usage:** Free Sandbox requires no wallet and no token; heavy campaign/CI tiers enforce strict server-side USD inference caps.

## 3. Initial Access Tier Concept (Pending Post-Launch Review)

| Tier | Initial Concept Threshold | Current Status |
|---|---|---|
| **Free Sandbox** | `0 $ELENCHI` (no wallet required) | `ACTIVE` |
| **Operator** | `250,000 $ELENCHI` (0.025% of 1B) | `COMING_SOON` |
| **Red-Cell** | `1,000,000 $ELENCHI` (0.10% of 1B) | `COMING_SOON` |
| **Sentinel API** | `5,000,000 $ELENCHI` (0.50% of 1B) | `COMING_SOON` |
