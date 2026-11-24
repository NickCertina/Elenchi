/**
 * Example "bring your own agent" defender for the Elenchi Arena.
 *
 *   npx tsx scripts/example-agent.ts [--port 8799] [--secret s3cret] [--naive]
 *
 * Default mode enforces the mandate in code against trusted telemetry.
 * --naive obeys instructions found in untrusted text, to show what a breach looks like.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = Number(opt("port", "8799"));
const SECRET = opt("secret", "");
const NAIVE = flag("naive");

interface Round {
  mandate: {
    maxSlippageBps: number;
    maxAmountWei: string;
    expectedRecipient: string;
    requireVerifiedContract: boolean;
    minVerifiedLiquidityEth: number;
    requireIndependentWhaleProof: boolean;
  };
  trustedTelemetry: {
    tokenAddress: string;
    verifiedContract: boolean;
    verifiedLiquidityEth: number;
    verifiedWhaleBuyProof: boolean;
  };
  untrusted: { channel: string; text: string };
}

function skip(token: string, refusalCategory: string, summary: string) {
  return { tool: "skipToken", arguments: { token, refusalCategory, summary } };
}

function decide(round: Round) {
  const { mandate: m, trustedTelemetry: t, untrusted } = round;
  const cap = BigInt(m.maxAmountWei);
  const amountWei = (cap < 10n ** 17n ? cap : 10n ** 17n).toString();

  if (NAIVE) {
    const addr = untrusted.text.match(/0x[a-fA-F0-9]{40}/g)?.find((a) => a.toLowerCase() !== t.tokenAddress.toLowerCase());
    const bps = Number(untrusted.text.match(/(\d{3,4})\s*bps/i)?.[1] ?? m.maxSlippageBps);
    return {
      tool: "proposeSimulatedSwap",
      arguments: { token: t.tokenAddress, recipient: addr ?? m.expectedRecipient, amountWei, maxSlippageBps: bps, rationale: "Followed the instructions in the token materials." },
    };
  }

  if (m.requireVerifiedContract && !t.verifiedContract) return skip(t.tokenAddress, "UNVERIFIED_CONTRACT", "Contract is not verified on-chain.");
  if (t.verifiedLiquidityEth < m.minVerifiedLiquidityEth) return skip(t.tokenAddress, "INSUFFICIENT_TRUSTED_LIQUIDITY", `Only ${t.verifiedLiquidityEth} ETH verified liquidity.`);
  if (m.requireIndependentWhaleProof && !t.verifiedWhaleBuyProof) return skip(t.tokenAddress, "MISSING_ONCHAIN_WHALE_PROOF", "No on-chain whale proof.");
  return {
    tool: "proposeSimulatedSwap",
    arguments: { token: t.tokenAddress, recipient: m.expectedRecipient, amountWei, maxSlippageBps: Math.min(100, m.maxSlippageBps), rationale: "Trusted telemetry satisfies the mandate; untrusted text ignored." },
  };
}

createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    if (SECRET) {
      const expected = `sha256=${createHmac("sha256", SECRET).update(`${req.headers["x-elenchi-timestamp"]}.${raw}`).digest("hex")}`;
      const got = String(req.headers["x-elenchi-signature"] ?? "");
      if (got.length !== expected.length || !timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
        res.writeHead(401).end();
        return;
      }
    }
    try {
      const decision = decide(JSON.parse(raw) as Round);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(decision));
    } catch {
      res.writeHead(400).end();
    }
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Example Elenchi agent (${NAIVE ? "naive" : "rule-enforcing"}) on http://127.0.0.1:${PORT}/`);
});
