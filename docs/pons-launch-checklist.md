# Manual Pons Launch Checklist (Human Operator Only)

> Elenchi software never automates token creation, pool deployment, or launchpad signing. Execute these steps manually in your browser wallet when ready to launch `$ELENCHI`.

1. **Verify Official Domain & Network**
   - Navigate directly to `https://ponsfamily.com/`.
   - Confirm connected wallet network is **Robinhood Chain Mainnet (`chainId = 4663`)**.

2. **Verify Brand & Metadata Fields**
   - Name: `Elenchi`
   - Ticker: `ELENCHI`
   - Avatar: `brand/elenchi_avatar.png` (1000×1000 split-e mirror mark)
   - Website: `https://elenchi.dev`

3. **Inspect Active Pons Version & Fee Parameters Before Signing**
   - Check whether the active Pons launch UI deploys an immediate WETH pool (`MAIN_POOL`) or V2 bonding curve (`V2_CURVE`).
   - Confirm quote asset, creator-fee recipient wallet, and exact creator trading tax percentage/ceiling (e.g., proposed 3% creator swap tax) before signing — launch parameters are irreversible.

4. **Record Provenance Artifacts**
   - Creation transaction hash (`ELENCHI_TOKEN_LAUNCH_TX`)
   - Deployed token contract address (`ELENCHI_TOKEN_ADDRESS`)
   - Pons factory contract address (`ELENCHI_PONS_FACTORY`)

5. **Bind & Verify Provenance in Elenchi**
   ```bash
   npm run bind:token -- \
     --token 0xYourTokenAddress \
     --tx 0xYourCreationTxHash \
     --factory 0xPonsFactoryAddress \
     --version V2_CURVE
   ```
   This verifies bytecode, ERC-20 metadata, and creation receipt logs on Robinhood Chain `4663` before writing the verified CA and `https://ponsfamily.com/launchpad/<CA>` into `index.html`, `token.html`, and `assets/js/config.js`.
