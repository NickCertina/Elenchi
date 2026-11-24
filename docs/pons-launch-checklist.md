# Manual Pons Launch Checklist (Human Operator Only)

> Elenchi software never automates token creation, pool deployment, or launchpad signing. Execute these steps manually in your browser wallet when ready to launch `$ELCHI`.

1. **Verify Official Domain & Network**
   - Navigate directly to `https://ponsfamily.com/`.
   - Confirm connected wallet network is **Robinhood Chain Mainnet (`chainId = 4663`)**.

2. **Verify Brand & Metadata Fields**
   - Name: `Elenchi`
   - Ticker: `ELCHI`
   - Avatar: `brand/elenchi_avatar.png` (1000×1000 split-e mirror mark)
   - Website: `https://elenchi.dev`
   - X: `https://x.com/Elenchi_rbh`
   - GitHub: `https://github.com/NickCertina/Elenchi`

3. **Inspect Active Pons Version & Fee Parameters Before Signing**
   - Check whether the active Pons launch UI deploys an immediate WETH pool (`MAIN_POOL`) or V2 bonding curve (`V2_CURVE`).
   - Confirm quote asset, creator-fee recipient wallet, and exact creator trading tax percentage/ceiling (e.g., proposed 3% creator swap tax) before signing — launch parameters are irreversible.

4. **Record Provenance Artifacts**
   - Deployed token contract address (`ELENCHI_TOKEN_ADDRESS`)
   - Creation transaction hash (`ELENCHI_TOKEN_LAUNCH_TX`, optional for fast bind)
   - Pons factory contract address (`ELENCHI_PONS_FACTORY`, optional for fast bind)

5. **Instant Bind, Deploy & Live HTML Verification**
   ```bash
   # Fast one-command rollout (accepts 0x... CA or https://ponsfamily.com/launchpad/0x...)
   npm run release:token -- 0xYourTokenAddress

   # Or local bind only (with optional creation tx & factory receipt check):
   npm run bind:token -- --token 0xYourTokenAddress --tx 0xYourCreationTxHash --factory 0xPonsFactoryAddress --version V2_CURVE
   ```
   This verifies live contract bytecode and ERC-20 metadata on Robinhood Chain `4663` before writing the verified CA and `https://ponsfamily.com/launchpad/<CA>` (`target="_blank" rel="noopener"`) directly into the HTML of `index.html` (HERO `Buy on Pons` button, HERO CA bar, Bento card, Header/Footer), `token.html`, and `assets/js/config.js` (with fresh `?v=...` cache-busting), deploying to `https://elenchi.dev`, and verifying the CA in the raw HTML of the live pages.
