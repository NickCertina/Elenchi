/**
 * Elenchi Public Client Config
 * NON-NEGOTIABLE: Until the project owner manually launches $ELCHI on Pons
 * and verifies on-chain provenance via `npm run bind:token`, `contract` MUST remain null.
 */
window.ELENCHI_CONFIG = {
  brand: "ELENCHI",
  ticker: "$ELCHI",
  chainId: 4663,
  testnetChainId: 46630,
  explorerUrl: "https://robinhoodchain.blockscout.com",
  testnetExplorerUrl: "https://explorer.testnet.chain.robinhood.com",
  tokenLaunchState: "LIVE",
  contract: "0xc71B4409512EF7fE4F714d79cEdEB38cbe485286",
  CA: "0xc71B4409512EF7fE4F714d79cEdEB38cbe485286",
  ponsLaunchpadUrl: "https://ponsfamily.com/launchpad/0xc71B4409512EF7fE4F714d79cEdEB38cbe485286",
  launchTx: null,
  twitterUrl: "https://x.com/Elenchi_rbh",
  githubUrl: "https://github.com/NickCertina/Elenchi",
};
