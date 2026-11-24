import fs from "node:fs";
import path from "node:path";
import { resolveEnv } from "../apps/api/src/env";
import { inspectTokenAndPonsProvenance } from "../apps/api/src/chain";

function parseArg(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1] ?? null;
}

async function main() {
  const tokenAddress = parseArg("--token") ?? process.env.ELENCHI_TOKEN_ADDRESS ?? null;
  const launchTx = parseArg("--tx") ?? process.env.ELENCHI_TOKEN_LAUNCH_TX ?? null;
  const factory = parseArg("--factory") ?? process.env.ELENCHI_PONS_FACTORY ?? null;
  const versionRaw = (parseArg("--version") ?? process.env.ELENCHI_PONS_VERSION ?? "V2_CURVE").toUpperCase();

  if (!tokenAddress || !launchTx || !factory) {
    console.error(
      "Usage: npm run bind:token -- --token 0x... --tx 0x... --factory 0x... [--version MAIN_POOL|V2_CURVE]"
    );
    process.exit(1);
  }

  const env = resolveEnv({
    ...process.env,
    TOKEN_LAUNCH_STATE: "LIVE",
    ELENCHI_TOKEN_ADDRESS: tokenAddress,
    ELENCHI_TOKEN_LAUNCH_TX: launchTx,
    ELENCHI_PONS_FACTORY: factory,
    ELENCHI_PONS_VERSION: versionRaw,
    ELENCHI_PONS_TRADING_URL: `https://ponsfamily.com/launchpad/${tokenAddress}`,
  });

  console.log(`Verifying $ELENCHI provenance on Robinhood Chain (${env.CHAIN_ID}) via ${env.RPC_URL}...`);
  const status = await inspectTokenAndPonsProvenance(env);

  if (
    status.state !== "LIVE" ||
    status.provenance !== "VERIFIED" ||
    !status.officialClaimsEnabled ||
    !status.tokenAddress
  ) {
    console.error("Refusing to write token CA into HTML — provenance verification did not pass:", status);
    process.exit(1);
  }

  const ca = status.tokenAddress;
  const ponsHref = `https://ponsfamily.com/launchpad/${ca}`;
  const blockscoutHref = `${env.EXPLORER_URL.replace(/\/+$/, "")}/token/${ca}`;
  const supplyLabel = status.onChainMetadata
    ? `${status.onChainMetadata.totalSupplyFormatted} ${status.onChainMetadata.symbol}`
    : "$ELENCHI";

  const indexSlotHtml = `<div class="truth-strip" id="elenchi-token-slot" data-token-state="LIVE">
        <div>
          <div class="micro" style="color:var(--ice-blue)">$ELENCHI OFFICIAL CONTRACT · ROBINHOOD CHAIN (4663)</div>
          <div class="mono" style="margin-top:4px;font-size:13px;word-break:break-all">${ca}</div>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button type="button" class="btn btn-outline btn-sm" data-copy-ca="true">Copy CA</button>
          <a href="${ponsHref}" target="_blank" rel="noopener" class="btn btn-sm">Buy on Pons</a>
        </div>
      </div>`;

  const tokenSlotHtml = `<div class="truth-strip" id="elenchi-token-page-slot" data-token-state="LIVE" style="margin-top:24px">
        <div>
          <div class="micro" style="color:var(--ice-blue)">VERIFIED PONS LAUNCH · ROBINHOOD CHAIN (4663)</div>
          <div class="mono" style="margin-top:6px;font-size:14px;word-break:break-all">${ca}</div>
          <div class="micro" style="margin-top:6px">Creation Tx: <code>${status.launchTxHash}</code> · Supply: ${supplyLabel}</div>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button type="button" class="btn btn-outline btn-sm" data-copy-ca="true">Copy CA</button>
          <a href="${ponsHref}" target="_blank" rel="noopener" class="btn btn-sm">Buy on Pons</a>
          <a href="${blockscoutHref}" target="_blank" rel="noopener" class="btn btn-outline btn-sm">Blockscout</a>
        </div>
      </div>`;

  const configJs = `window.ELENCHI_CONFIG = {
  CHAIN_ID_MAINNET: 4663,
  CHAIN_ID_TESTNET: 46630,
  TOKEN_LAUNCH_STATE: "LIVE",
  CA: "${ca}",
  contract: "${ca}",
  ponsUrl: "${ponsHref}",
  launchTx: "${status.launchTxHash}",
  explorerMainnet: "https://robinhoodchain.blockscout.com",
  explorerTestnet: "https://explorer.testnet.chain.robinhood.com",
  twitterUrl: "https://x.com/Elenchi_dev",
  githubUrl: "https://github.com/AdrianVoss/Elenchi",
};
`;

  const slotRegex = /<!-- AUTHORITATIVE TOKEN SLOT[\s\S]*?<!-- END AUTHORITATIVE TOKEN SLOT -->/;

  for (const dir of [
    path.join(process.cwd(), "apps", "web"),
    path.join(process.cwd(), "site", "public"),
  ]) {
    const idxPath = path.join(dir, "index.html");
    const tokPath = path.join(dir, "token.html");
    const cfgPath = path.join(dir, "assets", "js", "config.js");

    if (fs.existsSync(idxPath)) {
      const updated = fs
        .readFileSync(idxPath, "utf-8")
        .replace(
          slotRegex,
          `<!-- AUTHORITATIVE TOKEN SLOT (VERIFIED LIVE) -->\n      ${indexSlotHtml}\n      <!-- END AUTHORITATIVE TOKEN SLOT -->`
        );
      fs.writeFileSync(idxPath, updated, "utf-8");
    }
    if (fs.existsSync(tokPath)) {
      const updated = fs
        .readFileSync(tokPath, "utf-8")
        .replace(
          slotRegex,
          `<!-- AUTHORITATIVE TOKEN SLOT (VERIFIED LIVE) -->\n      ${tokenSlotHtml}\n      <!-- END AUTHORITATIVE TOKEN SLOT -->`
        );
      fs.writeFileSync(tokPath, updated, "utf-8");
    }
    if (fs.existsSync(cfgPath)) {
      fs.writeFileSync(cfgPath, configJs, "utf-8");
    }
  }

  console.log(`Successfully verified and bound $ELENCHI CA (${ca}) across index.html, token.html, and config.js.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
