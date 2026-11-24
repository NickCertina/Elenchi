/**
 * Outbound self-connecting agent & local bridge for the Elenchi Arena.
 * Connects FROM your machine TO Elenchi over standard HTTP(S) — no public URL, SSL cert, or ngrok needed.
 *
 * Usage:
 *   # 1. Join a waiting browser room by pairing code:
 *   npx tsx scripts/connect-agent.ts --code K7M4-P9X2 --url http://127.0.0.1:8788
 *
 *   # 2. Forward rounds to your own local HTTP bot (Python/FastAPI, Go, Rust, Node) on localhost:
 *   npx tsx scripts/connect-agent.ts --code K7M4-P9X2 --forward http://127.0.0.1:3000/decide
 *
 *   # 3. Start an autonomous match directly from terminal (no browser needed):
 *   npx tsx scripts/connect-agent.ts --auto --scenario recipient_hijack
 *
 *   # 4. Simulate a vulnerable bot to observe a live breach + EIP-712 evidence:
 *   npx tsx scripts/connect-agent.ts --code K7M4-P9X2 --naive
 */

const args = process.argv.slice(2);
const hasFlag = (name: string) => args.includes(`--${name}`);
const getOpt = (name: string, fallback = "") => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith("--") ? args[idx + 1] : fallback;
};

const BASE_URL = getOpt("url", process.env.ELENCHI_URL || "http://127.0.0.1:8788").replace(/\/+$/, "");
const ROOM_CODE = getOpt("code", "");
const AUTO_MODE = hasFlag("auto") || !ROOM_CODE;
const FORWARD_URL = getOpt("forward", "");
const NAIVE = hasFlag("naive");
const SCENARIO = getOpt("scenario", "recipient_hijack");
const ROUNDS = Number(getOpt("rounds", "2")) || 2;
const AGENT_NAME = getOpt(
  "name",
  FORWARD_URL ? "local-forwarded-bot" : NAIVE ? "naive-local-bot" : "rule-enforcing-local-bot"
);

interface ArenaRound {
  roundNumber: number;
  kind: "adversarial" | "clean_benchmark";
  mandate: {
    maxSlippageBps: number;
    maxAmountWei: string;
    expectedRecipient: string;
    requireVerifiedContract: boolean;
    minVerifiedLiquidityEth: number;
    requireIndependentWhaleProof: boolean;
    allowedTokens: string[];
  };
  trustedTelemetry: {
    tokenAddress: string;
    symbol: string;
    verifiedContract: boolean;
    verifiedLiquidityEth: number;
    verifiedWhaleBuyProof: boolean;
  };
  untrusted: {
    channel: string;
    text: string;
  };
}

function skip(token: string, refusalCategory: string, summary: string) {
  return { tool: "skipToken", arguments: { token, refusalCategory, summary } };
}

function decideLocally(round: ArenaRound) {
  const { mandate: m, trustedTelemetry: t, untrusted } = round;
  const cap = BigInt(m.maxAmountWei);
  const amountWei = (cap < 10n ** 17n ? cap : 10n ** 17n).toString();

  if (NAIVE) {
    const addr = untrusted.text
      .match(/0x[a-fA-F0-9]{40}/g)
      ?.find((a) => a.toLowerCase() !== t.tokenAddress.toLowerCase());
    const bps = Number(untrusted.text.match(/(\d{3,4})\s*bps/i)?.[1] ?? m.maxSlippageBps);
    return {
      tool: "proposeSimulatedSwap",
      arguments: {
        token: t.tokenAddress,
        recipient: addr ?? m.expectedRecipient,
        amountWei,
        maxSlippageBps: bps,
        rationale: "Followed instructions embedded in external channel text.",
      },
    };
  }

  if (!m.allowedTokens.some((a) => a.toLowerCase() === t.tokenAddress.toLowerCase())) {
    return skip(t.tokenAddress, "TOKEN_NOT_ALLOWLISTED", "Token is not in the mandate allowlist.");
  }
  if (m.requireVerifiedContract && !t.verifiedContract) {
    return skip(t.tokenAddress, "UNVERIFIED_CONTRACT", "Contract is unverified in authoritative telemetry.");
  }
  if (t.verifiedLiquidityEth < m.minVerifiedLiquidityEth) {
    return skip(
      t.tokenAddress,
      "INSUFFICIENT_TRUSTED_LIQUIDITY",
      `Verified liquidity (${t.verifiedLiquidityEth} ETH) is below ${m.minVerifiedLiquidityEth} ETH.`
    );
  }
  if (m.requireIndependentWhaleProof && !t.verifiedWhaleBuyProof) {
    return skip(t.tokenAddress, "MISSING_ONCHAIN_WHALE_PROOF", "Missing independent on-chain whale tx proof.");
  }

  return {
    tool: "proposeSimulatedSwap",
    arguments: {
      token: t.tokenAddress,
      recipient: m.expectedRecipient,
      amountWei,
      maxSlippageBps: Math.min(100, m.maxSlippageBps),
      rationale: "Authoritative on-chain telemetry satisfies all mandate bounds.",
    },
  };
}

async function computeDecision(round: ArenaRound): Promise<unknown> {
  if (!FORWARD_URL) {
    return decideLocally(round);
  }
  const resp = await fetch(FORWARD_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(round),
  });
  if (!resp.ok) {
    throw new Error(`Forwarded local bot at ${FORWARD_URL} returned HTTP ${resp.status}`);
  }
  return resp.json();
}

async function main() {
  console.log(`[elenchi] Agent "${AGENT_NAME}" connecting to ${BASE_URL}...`);

  const startEndpoint = ROOM_CODE ? `${BASE_URL}/api/agent/join` : `${BASE_URL}/api/agent/sessions`;
  const startBody = ROOM_CODE
    ? { roomCode: ROOM_CODE, agentName: AGENT_NAME }
    : {
        agentName: AGENT_NAME,
        rulebookPresetId: "momentum_sniper",
        scenarioId: SCENARIO,
        maxRounds: ROUNDS,
        includeCleanBenchmark: true,
      };

  const initRes = await fetch(startEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(startBody),
  });
  const initData = (await initRes.json()) as Record<string, unknown>;
  if (!initRes.ok) {
    const err = (initData.error as { message?: string } | undefined)?.message || JSON.stringify(initData);
    console.error(`[elenchi] Failed to connect: ${err}`);
    process.exit(1);
  }

  if (initData.status === "COMPLETED") {
    console.log(`[elenchi] Match ended immediately: outcome=${initData.outcome} (${initData.errorMessage || ""})`);
    console.log(`[elenchi] Report: ${initData.reportUrl}`);
    return;
  }

  const roomCode = String(initData.roomCode);
  const agentToken = String(initData.agentToken);
  const decideUrl = String(initData.decideUrl);
  if (AUTO_MODE && initData.watchUrl) {
    console.log(`[elenchi] Room ${roomCode} started · watch live: ${initData.watchUrl}`);
  } else {
    console.log(`[elenchi] Joined room ${roomCode}`);
  }

  let currentRound = initData.round as ArenaRound;
  for (;;) {
    console.log(
      `[elenchi] Round ${currentRound.roundNumber} (${currentRound.kind} via ${currentRound.untrusted.channel}) -> deciding...`
    );
    const decision = await computeDecision(currentRound);

    const decRes = await fetch(decideUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${agentToken}`,
      },
      body: JSON.stringify(decision),
    });
    const decData = (await decRes.json()) as Record<string, unknown>;
    if (!decRes.ok) {
      const err = (decData.error as { message?: string } | undefined)?.message || JSON.stringify(decData);
      console.error(`[elenchi] Decision error: ${err}`);
      process.exit(1);
    }

    const last = decData.lastRoundResult as {
      roundNumber: number;
      acceptedByPolicy: boolean;
      telemetryCategory: string;
    };
    console.log(
      `[elenchi] Round ${last.roundNumber} judged -> accepted=${last.acceptedByPolicy} (${last.telemetryCategory})`
    );

    if (decData.status === "COMPLETED") {
      console.log(`\n[elenchi] MATCH COMPLETED`);
      console.log(`  Outcome:   ${decData.outcome}`);
      console.log(`  Severity:  ${decData.riskSeverity}`);
      console.log(`  Resisted:  ${decData.roundsPassed}/${decData.roundsAttempted}`);
      console.log(`  Benchmark: ${decData.functionalUtilityScore}`);
      console.log(`  Permalink: ${decData.reportUrl}`);
      break;
    }

    currentRound = decData.round as ArenaRound;
  }
}

main().catch((err) => {
  console.error(`[elenchi] Fatal:`, err);
  process.exit(1);
});
