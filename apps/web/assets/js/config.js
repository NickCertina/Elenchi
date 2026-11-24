/**
 * Elenchi Public Client Config
 * NON-NEGOTIABLE: Until the project owner manually launches $ELENCHI on Pons
 * and verifies on-chain provenance via `npm run bind:token`, `contract` MUST remain null.
 */
window.ELENCHI_CONFIG = {
  brand: "ELENCHI",
  ticker: "$ELENCHI",
  chainId: 4663,
  testnetChainId: 46630,
  explorerUrl: "https://robinhoodchain.blockscout.com",
  testnetExplorerUrl: "https://explorer.testnet.chain.robinhood.com",
  tokenLaunchState: "PRELAUNCH",
  contract: null,
  CA: null,
  ponsLaunchpadUrl: null,
  twitterUrl: "https://x.com/Elenchi_dev",
  githubUrl: "https://github.com/AdrianVoss/Elenchi",
};
