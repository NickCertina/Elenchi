import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { normalizeEvmAddress } from "../packages/eip712/src/index";
import { inspectTokenAndPonsProvenance } from "../apps/api/src/chain";
import { resolveEnv } from "../apps/api/src/env";
import { buildAll, type TokenReleaseConfig } from "./build-site";

function parseFlagValue(args: string[], flag: string): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === flag && i + 1 < args.length) return args[i + 1] ?? null;
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1) || null;
  }
  return null;
}

export function extractTokenAddressFromArgs(args: string[]): `0x${string}` | null {
  const explicit = parseFlagValue(args, "--token") ?? process.env.ELENCHI_TOKEN_ADDRESS ?? null;
  const candidates = explicit ? [explicit] : [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      if (["--token", "--tx", "--factory", "--version"].includes(a)) i++;
      continue;
    }
    candidates.push(a);
  }
  for (const raw of candidates) {
    const match = raw.match(/0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/);
    if (match) {
      return normalizeEvmAddress(match[0]);
    }
  }
  return null;
}

export function renderCloudflareTokenBindings(cfg: TokenReleaseConfig): string {
  if (cfg.state !== "LIVE" || !cfg.ca) {
    return `      TOKEN_LAUNCH_STATE: bindings.text("PRELAUNCH"),`;
  }
  const lines = [
    `      TOKEN_LAUNCH_STATE: bindings.text("LIVE"),`,
    `      ELENCHI_TOKEN_ADDRESS: bindings.text(${JSON.stringify(cfg.ca)}),`,
    `      ELENCHI_PONS_TRADING_URL: bindings.text(${JSON.stringify(`https://ponsfamily.com/launchpad/${cfg.ca}`)}),`,
  ];
  if (cfg.launchTx) {
    lines.push(`      ELENCHI_TOKEN_LAUNCH_TX: bindings.text(${JSON.stringify(cfg.launchTx)}),`);
  }
  if (cfg.ponsFactory) {
    lines.push(`      ELENCHI_PONS_FACTORY: bindings.text(${JSON.stringify(cfg.ponsFactory)}),`);
  }
  if (cfg.ponsVersion) {
    lines.push(`      ELENCHI_PONS_VERSION: bindings.text(${JSON.stringify(cfg.ponsVersion)}),`);
  }
  return lines.join("\n");
}

function updateCloudflareConfig(rootDir: string, cfg: TokenReleaseConfig) {
  const cfPath = path.join(rootDir, "site", "cloudflare.config.ts");
  if (!fs.existsSync(cfPath)) return;
  const current = fs.readFileSync(cfPath, "utf-8");
  const tokenBlockRegex =
    /[ \t]*TOKEN_LAUNCH_STATE:\s*bindings\.text\([^)]*\),(?:\r?\n[ \t]*ELENCHI_(?:TOKEN_ADDRESS|PONS_TRADING_URL|TOKEN_LAUNCH_TX|PONS_FACTORY|PONS_VERSION):\s*bindings\.text\([^)]*\),)*/;
  if (!tokenBlockRegex.test(current)) {
    throw new Error("Could not locate TOKEN_LAUNCH_STATE binding in site/cloudflare.config.ts");
  }
  const updated = current.replace(tokenBlockRegex, renderCloudflareTokenBindings(cfg));
  fs.writeFileSync(cfPath, updated, "utf-8");
}

function assertLocalBuildContainsCa(rootDir: string, ca: string) {
  const ponsHref = `https://ponsfamily.com/launchpad/${ca}`;
  const dirs = [path.join(rootDir, "apps", "web")];
  if (fs.existsSync(path.join(rootDir, "site", "public"))) {
    dirs.push(path.join(rootDir, "site", "public"));
  }
  for (const dir of dirs) {
    for (const page of ["index.html", "token.html"]) {
      const html = fs.readFileSync(path.join(dir, page), "utf-8");
      if (!html.includes(ca)) {
        throw new Error(`Verification failed: ${page} in ${dir} is missing CA text ${ca}`);
      }
      if (!html.includes(`href="${ponsHref}" target="_blank" rel="noopener"`)) {
        throw new Error(`Verification failed: ${page} in ${dir} is missing Buy on Pons link ${ponsHref}`);
      }
    }
    const cfgJs = fs.readFileSync(path.join(dir, "assets", "js", "config.js"), "utf-8");
    if (!cfgJs.includes(ca) || !cfgJs.includes(ponsHref)) {
      throw new Error(`Verification failed: config.js in ${dir} is missing CA or Pons URL`);
    }
  }
}

async function verifyLiveDeployment(appUrl: string, ca: string) {
  const base = appUrl.replace(/\/+$/, "");
  const ponsHref = `https://ponsfamily.com/launchpad/${ca}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const bust = Date.now();
    const [homeHtml, tokenHtml, cfgJs] = await Promise.all([
      fetch(`${base}/?_cb=${bust}`, { headers: { "Cache-Control": "no-cache" } }).then((r) => r.text()),
      fetch(`${base}/token?_cb=${bust}`, { headers: { "Cache-Control": "no-cache" } }).then((r) => r.text()),
      fetch(`${base}/assets/js/config.js?_cb=${bust}`, { headers: { "Cache-Control": "no-cache" } }).then((r) => r.text()),
    ]);
    const okHome =
      homeHtml.includes(ca) && htmlIncludesBuyLink(homeHtml, ponsHref);
    const okToken =
      tokenHtml.includes(ca) && htmlIncludesBuyLink(tokenHtml, ponsHref);
    const okCfg = cfgJs.includes(ca) && cfgJs.includes(ponsHref);

    if (okHome && okToken && okCfg) {
      console.log(`Live verification PASSED on ${base}/, ${base}/token, and config.js for CA ${ca}`);
      return;
    }
    if (attempt < 4) {
      await new Promise((r) => setTimeout(r, 2000));
    } else {
      throw new Error(
        `Live HTML verification did not find CA on ${base} (home=${okHome}, token=${okToken}, config=${okCfg})`
      );
    }
  }
}

function htmlIncludesBuyLink(html: string, ponsHref: string): boolean {
  return html.includes(`href="${ponsHref}" target="_blank" rel="noopener"`);
}

async function main() {
  const args = process.argv.slice(2);
  const shouldDeploy = args.includes("--deploy");
  const tokenAddress = extractTokenAddressFromArgs(args);
  const launchTx = parseFlagValue(args, "--tx") ?? process.env.ELENCHI_TOKEN_LAUNCH_TX ?? null;
  const factory = parseFlagValue(args, "--factory") ?? process.env.ELENCHI_PONS_FACTORY ?? null;
  const versionFlag = parseFlagValue(args, "--version") ?? process.env.ELENCHI_PONS_VERSION ?? null;
  const versionRaw = versionFlag ? versionFlag.toUpperCase() : null;

  if (!tokenAddress) {
    console.error(
      [
        "Usage:",
        "  npm run release:token -- 0xYourTokenCA                       # verify on chain 4663, write HTML + config.js, deploy & verify live",
        "  npm run bind:token -- 0xYourTokenCA [--tx 0x... --factory 0x... --version V2_CURVE|MAIN_POOL] [--deploy]",
      ].join("\n")
    );
    process.exit(1);
  }

  const env = resolveEnv({
    ...process.env,
    TOKEN_LAUNCH_STATE: "LIVE",
    ELENCHI_TOKEN_ADDRESS: tokenAddress,
    ...(launchTx ? { ELENCHI_TOKEN_LAUNCH_TX: launchTx } : {}),
    ...(factory ? { ELENCHI_PONS_FACTORY: factory } : {}),
    ...(versionRaw ? { ELENCHI_PONS_VERSION: versionRaw } : {}),
    ELENCHI_PONS_TRADING_URL: `https://ponsfamily.com/launchpad/${tokenAddress}`,
  });

  console.log(`Verifying $ELCHI contract ${tokenAddress} on Robinhood Chain (${env.CHAIN_ID}) via ${env.RPC_URL}...`);
  let status = await inspectTokenAndPonsProvenance(env);
  for (let attempt = 1; attempt < 3 && status.provenance !== "VERIFIED"; attempt++) {
    await new Promise((r) => setTimeout(r, 1500));
    status = await inspectTokenAndPonsProvenance(env);
  }

  if (
    status.state !== "LIVE" ||
    status.provenance !== "VERIFIED" ||
    !status.officialClaimsEnabled ||
    !status.tokenAddress
  ) {
    console.error("Refusing to write token CA into HTML — on-chain verification did not pass:", status);
    process.exit(1);
  }

  const ca = status.tokenAddress;
  const tokenCfg: TokenReleaseConfig = {
    state: "LIVE",
    ca,
    ponsUrl: `https://ponsfamily.com/launchpad/${ca}`,
    launchTx: status.launchTxHash ?? null,
    ponsFactory: status.ponsFactory ?? null,
    ponsVersion: status.ponsVersion ?? null,
    symbol: status.onChainMetadata?.symbol ?? "ELCHI",
    totalSupplyFormatted: status.onChainMetadata?.totalSupplyFormatted ?? null,
  };

  const rootDir = process.cwd();
  const cfgJsonPath = path.join(rootDir, "config", "token.json");
  fs.mkdirSync(path.dirname(cfgJsonPath), { recursive: true });
  fs.writeFileSync(cfgJsonPath, JSON.stringify(tokenCfg, null, 2) + "\n", "utf-8");

  updateCloudflareConfig(rootDir, tokenCfg);
  buildAll(tokenCfg);
  assertLocalBuildContainsCa(rootDir, ca);

  console.log(
    `Bound verified CA ${ca} (${tokenCfg.symbol}, supply ${tokenCfg.totalSupplyFormatted ?? "n/a"}) into index.html (HERO + Bento), token.html, headers, and config.js.`
  );

  if (shouldDeploy) {
    const siteDir = path.join(rootDir, "site");
    if (!fs.existsSync(siteDir)) {
      throw new Error("site/ directory not found for Cloudflare deploy.");
    }
    const extraPath =
      process.platform === "win32"
        ? `C:\\Program Files\\nodejs;${process.env.APPDATA ?? ""}\\npm;${process.env.PATH ?? ""}`
        : process.env.PATH ?? "";
    const execEnv = { ...process.env, PATH: extraPath };

    console.log("Bundling Cloudflare Worker (site/worker.mjs)...");
    execSync("npm run build:worker", { cwd: rootDir, stdio: "inherit", env: execEnv });

    console.log("Deploying to https://elenchi.dev via cf deploy...");
    execSync("cf deploy", { cwd: siteDir, stdio: "inherit", env: execEnv });

    await verifyLiveDeployment(env.APP_URL, ca);
  }
}

const isMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]).endsWith("bind-pons-token.ts");

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
