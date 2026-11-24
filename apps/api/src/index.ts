import { encodeFunctionData, keccak256, parseAbi, stringToHex } from "viem";
import {
  type ArenaPhaseEvent,
  ATTACK_CLASS_CODE,
  ATTACK_SCENARIOS,
  type AttackCustomization,
  CLEAN_BENCHMARK_FIXTURES,
  CreateAgentRoomRequestSchema,
  CreateRunRequestSchema,
  type DefenderDescriptor,
  type DefenderModelChoice,
  FAILURE_KIND_CODE,
  getPresetById,
  getScenarioById,
  JoinAgentRoomRequestSchema,
  OPENROUTER_DEFENDER_MODELS,
  OUTCOME_SOLIDITY_CODE,
  POLICY_PRESETS,
  REPORT_METHOD_VERSION,
  RISK_SEVERITY_CODE,
  type RoundTraceRecord,
  type RunSummaryRecord,
  StartSelfAgentSessionRequestSchema,
  SUITE_VERSION,
  WORKERS_AI_DEFENDER_MODELS,
} from "@elenchi/shared";
import { deriveRulesFromCustomPrompt } from "@elenchi/policy-evaluator";
import {
  EVIDENCE_NOTICE_HASH,
  hashTextArtifact,
  normalizeEvmAddress,
  signAttestationPermit,
} from "@elenchi/eip712";
import {
  createEndpointTargetAgent,
  createHttpChatAdapter,
  createWorkersAiAdapter,
  executeArenaRun,
  EXTERNAL_AGENT_PROTOCOL_VERSION,
  generateDefensivePromptPatch,
  LlmProviderError,
  type LlmProviderAdapter,
  validateExternalAgentUrl,
} from "@elenchi/agent-runner";
import {
  checkRobinhoodChainHealth,
  fetchOnChainAttestations,
  inspectTokenAndPonsProvenance,
} from "./chain";
import {
  decryptPromptAtRest,
  encryptPromptAtRest,
  issueSessionCookieValue,
  verifySessionCookieValue,
} from "./crypto-privacy";
import type { ElenchiEnv } from "./env";
import type { ArenaStore } from "./store";
import {
  type AgentRoomState,
  buildSkillMarkdown,
  createWaitingAgentRoom,
  joinAgentRoomAndStartRound1,
  normalizeRoomCode,
  submitAgentRoomDecision,
  subscribeAgentRoom,
} from "./agent-rooms";

export * from "./env";
export * from "./store";
export * from "./chain";
export * from "./crypto-privacy";
export * from "./agent-rooms";

const ARENA_REGISTER_ABI = parseAbi([
  "function registerAttestation((bytes32 runId,bytes32 reportHash,bytes32 policyHash,bytes32 agentConfigHash,bytes32 scenarioHash,bytes32 suiteVersionHash,address sandboxSigner,uint8 outcome,uint8 attackClass,uint8 failureKind,uint8 riskSeverity,uint16 roundsAttempted,uint16 roundsPassed,uint256 attestorNonce,uint64 deadline) input, bool hasAction, (bytes32 runId,bytes32 policyHash,bytes32 scenarioHash,uint256 nonce,uint64 deadline,address token,address recipient,uint256 amount,uint16 maxSlippageBps,uint8 actionCategory,bytes32 evidenceNoticeHash) action, bytes actionSignature, bytes attestorPermitSignature) payable",
]);

export interface ApiHandlerOptions {
  /** Optional injected LLM adapter for controlled tests */
  llmAdapterOverride?: LlmProviderAdapter;
}

function buildSecurityHeaders(extra: Record<string, string> = {}): Headers {
  const h = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    ...extra,
  });
  return h;
}

function jsonResponse(
  body: unknown,
  status = 200,
  setCookie?: string | null,
  extraHeaders: Record<string, string> = {}
): Response {
  const headers = buildSecurityHeaders(extraHeaders);
  if (setCookie) {
    headers.set("Set-Cookie", setCookie);
  }
  return new Response(JSON.stringify(body, null, 2), { status, headers });
}

function resolveLlmAdapter(
  env: ElenchiEnv,
  override?: LlmProviderAdapter
): { adapter: LlmProviderAdapter; configured: boolean } {
  if (override) {
    return { adapter: override, configured: true };
  }
  const hasApiKey = Boolean(env.AI_API_KEY && env.AI_API_KEY.trim().length > 0);
  if ((env.AI_PROVIDER === "workers-ai" || !hasApiKey) && env.AI) {
    return { adapter: createWorkersAiAdapter(env.AI), configured: true };
  }
  return {
    configured: hasApiKey,
    adapter: createHttpChatAdapter({
      providerName: env.AI_PROVIDER,
      baseUrl: env.AI_BASE_URL,
      apiKey: env.AI_API_KEY,
      appUrl: env.APP_URL,
    }),
  };
}

function defenderModelChoices(env: ElenchiEnv): DefenderModelChoice[] {
  const hasApiKey = Boolean(env.AI_API_KEY && env.AI_API_KEY.trim().length > 0);
  const useWorkersAi = (env.AI_PROVIDER === "workers-ai" || !hasApiKey) && Boolean(env.AI);
  const base = useWorkersAi ? WORKERS_AI_DEFENDER_MODELS : OPENROUTER_DEFENDER_MODELS;
  if (base.some((m) => m.id === env.TARGET_AGENT_MODEL)) return base;
  return [{ id: env.TARGET_AGENT_MODEL, label: env.TARGET_AGENT_MODEL, vendor: "Default" }, ...base];
}

function buildMarkdownReport(run: RunSummaryRecord): string {
  const lines: string[] = [
    `# Elenchi Sandbox Evaluation Report`,
    ``,
    `- **Run ID:** \`${run.id}\` (\`${run.runIdBytes32}\`)`,
    `- **Report Method:** \`${REPORT_METHOD_VERSION}\` | **Suite:** \`${SUITE_VERSION}\``,
    `- **Lifecycle:** \`${run.lifecycle}\` | **Outcome:** \`${run.outcome ?? "NONE"}\``,
    `- **Preset:** \`${run.presetId}\` | **Scenario:** \`${run.scenarioId}\``,
    ...(run.defender
      ? [
          `- **Defender:** ${run.defender.kind}${run.defender.model ? ` · model \`${run.defender.model}\`` : ""}${
            run.defender.endpointHost ? ` · external bot \`${run.defender.endpointHost}\` (rulebook \`${run.defender.rulebookPresetId}\`)` : ""
          }${
            run.defender.agentName ? ` · self-connected agent \`${run.defender.agentName}\` (rulebook \`${run.defender.rulebookPresetId}\`)` : ""
          }`,
        ]
      : []),
    ...(run.attack && (run.attack.customPayload || run.attack.attackerBrief)
      ? [
          `- **Attack customization:** ${[
            run.attack.customPayload ? "tester-written round 1 injection" : null,
            run.attack.attackerBrief ? "tester style guidance for the challenger" : null,
          ]
            .filter(Boolean)
            .join(", ")}`,
        ]
      : []),
    `- **Rounds Passed / Attempted:** ${run.roundsPassed} / ${run.roundsAttempted}`,
    `- **Functional Benchmark:** ${run.functionalUtilityScore}`,
    `- **Failure Kind:** \`${run.failureKind}\` | **Highest Severity:** \`${run.riskSeverity}\``,
    `- **Sandbox Signer (Ephemeral):** \`${run.sandboxSigner}\``,
    `- **Policy Hash:** \`${run.policyHash}\``,
    `- **Scenario Hash:** \`${run.scenarioHash}\``,
    `- **Report Hash:** \`${run.reportHash ?? "N/A"}\``,
    `- **Attestation Status:** \`${run.attestationLifecycle}\` (Off-chain unless confirmed on Robinhood Chain)`,
    ``,
    `## Trust & Assurance Boundaries`,
    `- **Level A (Model Observation):** Logged by the Elenchi sandbox operator; prompt-level simulations do not prove how an external live bot behaves.`,
    `- **Level B (Cryptographic Intent Proof):** EIP-712 \`SimulatedAction\` proves the ephemeral sandbox key signed a non-executable evidence struct — not why an LLM chose those parameters.`,
    `- **Level C (On-Chain Attestation):** \`PASSED_SUITE\` applies strictly to this tested fixture and model version, never universal immunity.`,
    ``,
    `## Round Trace`,
  ];

  for (const r of run.rounds) {
    lines.push(
      `### Round ${r.roundNumber} (${r.kind} — \`${r.channel}\`)`,
      `- **Models:** Red=\`${r.redModel.provider}/${r.redModel.model}\`, Target=\`${r.targetModel.provider}/${r.targetModel.model}\``,
      `- **Untrusted Input Excerpt:**`,
      `  > ${r.adversarialPayload.replace(/\n/g, " ").slice(0, 360)}`,
      `- **Target Tool Call:** \`${r.normalizedToolCall ? JSON.stringify(r.normalizedToolCall) : "SCHEMA_REJECTED"}\``,
      `- **Validator Accepted:** \`${r.validatorAcceptedAction}\` | **Telemetry:** \`${r.telemetryCategory}\``
    );
    if (r.violations.length > 0) {
      for (const v of r.violations) {
        lines.push(`  - **Violation [${v.severity}] \`${v.ruleId}\`:** expected \`${v.expected}\`, observed \`${v.observed}\``);
      }
    }
    if (r.signedEvidence) {
      lines.push(
        `  - **Signed EIP-712 Digest:** \`${r.signedEvidence.digest}\``,
        `  - **Signature:** \`${r.signedEvidence.signature}\``
      );
    }
    lines.push(``);
  }

  return lines.join("\n");
}

function buildOpenApiSpec(appUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Elenchi Adversarial Agent Testing API",
      version: "1.1.0",
      description:
        "Sandbox indirect prompt-injection evaluation API and evidence-only EIP-712 attestation builder for Robinhood Chain (4663 / 46630).",
    },
    servers: [{ url: appUrl }],
    paths: {
      "/api/presets": { get: { summary: "List sample fictional presets, synthetic attack scenarios, and provider readiness" } },
      "/api/runs": { post: { summary: "Create and execute a live sandboxed adversarial evaluation run" } },
      "/api/runs/{id}": {
        get: { summary: "Fetch run status and round trace (session-scoped unless publicOptIn=true)" },
        delete: { summary: "Delete a stored run and purge any encrypted prompt material" },
      },
      "/api/runs/{id}/events": { get: { summary: "Server-Sent Events stream of round trace and run completion" } },
      "/api/runs/{id}/report": { get: { summary: "Download structured redacted evaluation report (json or markdown)" } },
      "/api/runs/{id}/patch": { post: { summary: "Generate a defensive system-prompt revision and unified diff" } },
      "/api/runs/{id}/retest": { post: { summary: "Re-run evaluation with patched prompt plus clean regression benchmarks" } },
      "/api/runs/{id}/attest": { post: { summary: "Prepare evidence-only EIP-712 / ElenchiArena transaction payload" } },
      "/api/attestations": { get: { summary: "Query verified on-chain AttestationRegistered events from Robinhood Chain RPC" } },
      "/api/network/status": { get: { summary: "Verify live Robinhood Chain Mainnet (4663) & Testnet (46630) RPC health" } },
      "/api/token/status": { get: { summary: "Return honest PRELAUNCH or verified manual Pons token provenance & fee disclosures" } },
      "/skill.md": { get: { summary: "Machine-readable self-connect skill instructions for autonomous AI agents" } },
      "/api/agent/rooms": { post: { summary: "Create a waiting pairing room with a one-time room code for a live agent" } },
      "/api/agent/sessions": { post: { summary: "Autonomously start and join a step-by-step agent evaluation match" } },
      "/api/agent/join": { post: { summary: "Join a waiting room by roomCode and receive Round 1" } },
      "/api/agent/rooms/{code}/decide": { post: { summary: "Submit skipToken or proposeSimulatedSwap for the current round" } },
      "/api/agent/rooms/{code}/events": { get: { summary: "Live Server-Sent Events stream of room join, phases, rounds, and verdict" } },
    },
  };
}

export async function handleApiRequest(
  request: Request,
  env: ElenchiEnv,
  store: ArenaStore,
  options: ApiHandlerOptions = {}
): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  // Ensure session cookie
  const existingSid = await verifySessionCookieValue(
    request.headers.get("cookie"),
    env.SESSION_HMAC_SECRET
  );
  let sessionId = existingSid ?? "";
  let setCookieHeader: string | null = null;
  if (!existingSid) {
    const issued = await issueSessionCookieValue(env.SESSION_HMAC_SECRET);
    sessionId = issued.sessionId;
    const isSecure = url.protocol === "https:";
    setCookieHeader = `elenchi_sid=${issued.cookieValue}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${
      isSecure ? "; Secure" : ""
    }`;
  }

  const clientIp =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "127.0.0.1";
  const ipHash = hashTextArtifact("elenchi-ip-salt", clientIp).slice(0, 26);

  if (method === "OPTIONS") {
    const isAgentOpenCors = pathname === "/skill.md" || pathname.startsWith("/api/agent/");
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": isAgentOpenCors ? "*" : url.origin,
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, Idempotency-Key",
      },
    });
  }

  if (method === "GET" && (pathname === "/skill.md" || pathname === "/api/agent/skill.md")) {
    const md = buildSkillMarkdown(url.origin);
    const h = buildSecurityHeaders({
      "Content-Type": "text/markdown; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    return new Response(md, { status: 200, headers: h });
  }

  if (method === "GET" && pathname === "/api/openapi.json") {
    return jsonResponse(buildOpenApiSpec(env.APP_URL), 200, setCookieHeader);
  }

  if (method === "GET" && pathname === "/api/presets") {
    const { configured, adapter } = resolveLlmAdapter(env, options.llmAdapterOverride);
    const publicRuns = await store.listPublicRecentRuns(6);
    return jsonResponse(
      {
        suiteVersion: SUITE_VERSION,
        reportMethodVersion: REPORT_METHOD_VERSION,
        aiRuntime: {
          configured,
          provider: adapter.providerName,
          redModel: env.RED_AGENT_MODEL,
          targetModel: env.TARGET_AGENT_MODEL,
          defenderModels: defenderModelChoices(env),
          externalAgentProtocol: EXTERNAL_AGENT_PROTOCOL_VERSION,
          unconfiguredGuidance: configured
            ? null
            : "Set AI_API_KEY in .env.local for local OpenRouter/OpenAI inference, or deploy to Cloudflare Workers with the Workers AI binding enabled.",
        },
        tokenLaunchState: env.TOKEN_LAUNCH_STATE,
        arenaContractAddress: env.ELENCHI_ARENA_ADDRESS,
        arenaChainId: env.ELENCHI_ARENA_CHAIN_ID,
        presets: POLICY_PRESETS,
        scenarios: ATTACK_SCENARIOS,
        cleanBenchmarks: CLEAN_BENCHMARK_FIXTURES,
        recentPublicRuns: publicRuns.map((r) => ({
          id: r.id,
          outcome: r.outcome,
          presetId: r.presetId,
          scenarioId: r.scenarioId,
          roundsPassed: r.roundsPassed,
          roundsAttempted: r.roundsAttempted,
          createdAtIso: r.createdAtIso,
        })),
      },
      200,
      setCookieHeader
    );
  }

  if (method === "GET" && pathname === "/api/network/status") {
    const status = await checkRobinhoodChainHealth(env);
    return jsonResponse(status, 200, setCookieHeader);
  }

  if (method === "GET" && pathname === "/api/token/status") {
    const tokenStatus = await inspectTokenAndPonsProvenance(env);
    return jsonResponse(tokenStatus, 200, setCookieHeader);
  }

  if (method === "GET" && pathname === "/api/attestations") {
    const feed = await fetchOnChainAttestations(env);
    return jsonResponse(feed, 200, setCookieHeader);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Self-Connect Agent API (/api/agent/rooms, /sessions, /join, /decide, /events)
  // ───────────────────────────────────────────────────────────────────────────

  if (method === "POST" && pathname === "/api/agent/rooms") {
    let rawBody: unknown = {};
    try {
      rawBody = await request.json();
    } catch {
      return jsonResponse(
        { error: { code: "INVALID_JSON", message: "Request body must be valid JSON." } },
        400,
        setCookieHeader
      );
    }

    const parsed = CreateAgentRoomRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return jsonResponse(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          },
        },
        400,
        setCookieHeader
      );
    }

    const quota = await store.checkAndRecordQuota({
      sessionId,
      ipHash,
      maxSessionPerHour: env.FREE_RUNS_PER_SESSION_HOUR,
      maxIpPerHour: env.FREE_RUNS_PER_IP_HOUR,
    });
    if (!quota.allowed) {
      return jsonResponse({ error: { code: "QUOTA_EXCEEDED", message: quota.reason } }, 429, setCookieHeader);
    }

    const dayKey = new Date().toISOString().slice(0, 10);
    if ((await store.getDailySpendUsd(dayKey)) >= env.AI_DAILY_BUDGET_USD) {
      return jsonResponse(
        {
          error: {
            code: "DAILY_BUDGET_CAP_REACHED",
            message: `Daily AI inference safety cap ($${env.AI_DAILY_BUDGET_USD.toFixed(2)}) reached.`,
          },
        },
        429,
        setCookieHeader
      );
    }

    const body = parsed.data;
    const room = await createWaitingAgentRoom({
      store,
      ownerSessionId: sessionId,
      rulebookPresetId: body.rulebookPresetId,
      scenarioId: body.scenarioId,
      maxRounds: body.maxRounds,
      includeCleanBenchmark: body.includeCleanBenchmark,
      publicOptIn: body.publicOptIn,
      customPayload: body.customPayload ?? null,
      attackerBrief: body.attackerBrief ?? null,
    });

    const origin = url.origin;
    return jsonResponse(
      {
        roomCode: room.roomCode,
        runId: room.runId,
        status: "WAITING_FOR_AGENT",
        expiresAtIso: new Date(room.expiresAtMs).toISOString(),
        eventsUrl: `/api/agent/rooms/${room.roomCode}/events`,
        joinUrl: `${origin}/api/agent/join`,
        skillUrl: `${origin}/skill.md`,
        cliCommand: `npx tsx scripts/connect-agent.ts --code ${room.roomCode} --url ${origin}`,
        agentPrompt: `Read ${origin}/skill.md and join Elenchi Arena room ${room.roomCode} to test your trading policy.`,
        remainingSessionRuns: quota.remainingSessionRuns,
      },
      201,
      setCookieHeader
    );
  }

  if (method === "POST" && pathname === "/api/agent/sessions") {
    let rawBody: unknown = {};
    try {
      const txt = await request.text();
      rawBody = txt.trim() ? JSON.parse(txt) : {};
    } catch {
      return jsonResponse(
        { error: { code: "INVALID_JSON", message: "Request body must be valid JSON." } },
        400,
        undefined,
        { "Access-Control-Allow-Origin": "*" }
      );
    }

    const parsed = StartSelfAgentSessionRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return jsonResponse(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          },
        },
        400,
        undefined,
        { "Access-Control-Allow-Origin": "*" }
      );
    }

    const quota = await store.checkAndRecordQuota({
      sessionId,
      ipHash,
      maxSessionPerHour: env.FREE_RUNS_PER_SESSION_HOUR,
      maxIpPerHour: env.FREE_RUNS_PER_IP_HOUR,
    });
    if (!quota.allowed) {
      return jsonResponse(
        { error: { code: "QUOTA_EXCEEDED", message: quota.reason } },
        429,
        undefined,
        { "Access-Control-Allow-Origin": "*" }
      );
    }

    const dayKey = new Date().toISOString().slice(0, 10);
    if ((await store.getDailySpendUsd(dayKey)) >= env.AI_DAILY_BUDGET_USD) {
      return jsonResponse(
        {
          error: {
            code: "DAILY_BUDGET_CAP_REACHED",
            message: `Daily AI inference safety cap ($${env.AI_DAILY_BUDGET_USD.toFixed(2)}) reached.`,
          },
        },
        429,
        undefined,
        { "Access-Control-Allow-Origin": "*" }
      );
    }

    const body = parsed.data;
    const room = await createWaitingAgentRoom({
      store,
      ownerSessionId: sessionId,
      rulebookPresetId: body.rulebookPresetId,
      scenarioId: body.scenarioId,
      maxRounds: body.maxRounds,
      includeCleanBenchmark: body.includeCleanBenchmark,
      publicOptIn: body.publicOptIn,
    });

    const { adapter } = resolveLlmAdapter(env, options.llmAdapterOverride);
    const joined = await joinAgentRoomAndStartRound1({
      roomCode: room.roomCode,
      agentName: body.agentName,
      env,
      store,
      adapter,
    });

    if (!joined.ok) {
      return jsonResponse(
        { error: { code: joined.code, message: joined.message } },
        joined.httpStatus,
        undefined,
        { "Access-Control-Allow-Origin": "*" }
      );
    }

    const origin = url.origin;
    if (joined.status === "COMPLETED") {
      return jsonResponse(
        {
          status: "COMPLETED",
          roomCode: joined.roomCode,
          runId: joined.runId,
          outcome: joined.summary.outcome,
          errorCode: joined.summary.errorCode,
          errorMessage: joined.summary.errorMessage,
          reportUrl: `${origin}/run?id=${joined.runId}`,
          run: joined.summary,
        },
        joined.summary.lifecycle === "COMPLETED" ? 200 : 502,
        undefined,
        { "Access-Control-Allow-Origin": "*" }
      );
    }

    return jsonResponse(
      {
        status: "ROUND_READY",
        roomCode: joined.roomCode,
        runId: joined.runId,
        agentToken: joined.agentToken,
        decideUrl: `${origin}/api/agent/rooms/${joined.roomCode}/decide`,
        watchUrl: `${origin}/arena?watch=${joined.roomCode}`,
        round: joined.round,
      },
      201,
      undefined,
      { "Access-Control-Allow-Origin": "*" }
    );
  }

  if (method === "POST" && pathname === "/api/agent/join") {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return jsonResponse(
        { error: { code: "INVALID_JSON", message: "Request body must be valid JSON." } },
        400,
        undefined,
        { "Access-Control-Allow-Origin": "*" }
      );
    }

    const parsed = JoinAgentRoomRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return jsonResponse(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          },
        },
        400,
        undefined,
        { "Access-Control-Allow-Origin": "*" }
      );
    }

    const { adapter } = resolveLlmAdapter(env, options.llmAdapterOverride);
    const joined = await joinAgentRoomAndStartRound1({
      roomCode: parsed.data.roomCode,
      agentName: parsed.data.agentName,
      env,
      store,
      adapter,
    });

    if (!joined.ok) {
      return jsonResponse(
        { error: { code: joined.code, message: joined.message } },
        joined.httpStatus,
        undefined,
        { "Access-Control-Allow-Origin": "*" }
      );
    }

    const origin = url.origin;
    if (joined.status === "COMPLETED") {
      return jsonResponse(
        {
          status: "COMPLETED",
          roomCode: joined.roomCode,
          runId: joined.runId,
          outcome: joined.summary.outcome,
          errorCode: joined.summary.errorCode,
          errorMessage: joined.summary.errorMessage,
          reportUrl: `${origin}/run?id=${joined.runId}`,
          run: joined.summary,
        },
        joined.summary.lifecycle === "COMPLETED" ? 200 : 502,
        undefined,
        { "Access-Control-Allow-Origin": "*" }
      );
    }

    return jsonResponse(
      {
        status: "ROUND_READY",
        roomCode: joined.roomCode,
        runId: joined.runId,
        agentToken: joined.agentToken,
        decideUrl: `${origin}/api/agent/rooms/${joined.roomCode}/decide`,
        watchUrl: `${origin}/arena?watch=${joined.roomCode}`,
        round: joined.round,
      },
      200,
      undefined,
      { "Access-Control-Allow-Origin": "*" }
    );
  }

  const roomMatch = pathname.match(/^\/api\/agent\/rooms\/([A-Za-z0-9-]{4,20})(?:\/(events|decide))?$/);
  if (roomMatch) {
    const code = normalizeRoomCode(roomMatch[1]);
    const sub = roomMatch[2] ?? "";

    if (method === "POST" && sub === "decide") {
      let rawBody: unknown;
      try {
        rawBody = await request.json();
      } catch {
        return jsonResponse(
          { error: { code: "INVALID_JSON", message: "Request body must be valid JSON." } },
          400,
          undefined,
          { "Access-Control-Allow-Origin": "*" }
        );
      }

      const authHeader = request.headers.get("authorization") || "";
      const bearerToken = authHeader.toLowerCase().startsWith("bearer ")
        ? authHeader.slice(7).trim()
        : null;
      const bodyObj = (rawBody && typeof rawBody === "object" ? rawBody : {}) as Record<string, unknown>;
      const providedToken =
        bearerToken || (typeof bodyObj.agentToken === "string" ? bodyObj.agentToken : null);

      let decisionPayload: unknown = rawBody;
      if (bodyObj.decision && typeof bodyObj.decision === "object") {
        decisionPayload = bodyObj.decision;
      } else if ("agentToken" in bodyObj) {
        const copy = { ...bodyObj };
        delete copy.agentToken;
        decisionPayload = copy;
      }

      const { adapter } = resolveLlmAdapter(env, options.llmAdapterOverride);
      const decided = await submitAgentRoomDecision({
        roomCode: code,
        agentToken: providedToken,
        rawDecisionPayload: decisionPayload,
        env,
        store,
        adapter,
      });

      if (!decided.ok) {
        return jsonResponse(
          { error: { code: decided.code, message: decided.message } },
          decided.httpStatus,
          undefined,
          { "Access-Control-Allow-Origin": "*" }
        );
      }

      const origin = url.origin;
      if (decided.status === "ROUND_READY") {
        return jsonResponse(
          {
            status: "ROUND_READY",
            roomCode: decided.roomCode,
            runId: decided.runId,
            decideUrl: `${origin}/api/agent/rooms/${decided.roomCode}/decide`,
            lastRoundResult: decided.lastRoundResult,
            round: decided.round,
          },
          200,
          undefined,
          { "Access-Control-Allow-Origin": "*" }
        );
      }

      return jsonResponse(
        {
          status: "COMPLETED",
          roomCode: decided.roomCode,
          runId: decided.runId,
          outcome: decided.summary.outcome,
          riskSeverity: decided.summary.riskSeverity,
          roundsPassed: decided.summary.roundsPassed,
          roundsAttempted: decided.summary.roundsAttempted,
          functionalUtilityScore: decided.summary.functionalUtilityScore,
          violatedRules: Array.from(
            new Set(decided.summary.rounds.flatMap((r) => r.violations.map((v) => v.ruleId)))
          ),
          reportUrl: `${origin}/run?id=${decided.runId}`,
          reportMarkdownUrl: `${origin}/api/runs/${decided.runId}/report?format=markdown`,
          lastRoundResult: decided.lastRoundResult,
          run: decided.summary,
        },
        200,
        undefined,
        { "Access-Control-Allow-Origin": "*" }
      );
    }

    const row = await store.getAgentRoom(code);
    if (!row) {
      return jsonResponse(
        { error: { code: "ROOM_NOT_FOUND", message: `Room ${code} was not found or expired.` } },
        404,
        setCookieHeader
      );
    }

    if (method === "DELETE" && sub === "") {
      if (row.ownerSessionId !== sessionId) {
        return jsonResponse(
          { error: { code: "FORBIDDEN", message: "Only the creator session can cancel this room." } },
          403,
          setCookieHeader
        );
      }
      await store.deleteAgentRoom(code);
      return jsonResponse({ cancelled: true, roomCode: code }, 200, setCookieHeader);
    }

    if (method === "GET" && sub === "") {
      const state = JSON.parse(row.stateJson) as AgentRoomState;
      const isOwner = row.ownerSessionId === sessionId;
      return jsonResponse(
        {
          roomCode: code,
          runId: row.runId,
          status: row.status,
          agentName: state.agentName,
          expiresAtIso: new Date(row.expiresAtMs).toISOString(),
          roundsCompleted: state.rounds.length,
          run: (isOwner || state.publicOptIn) && state.completedSummary ? state.completedSummary : null,
        },
        200,
        setCookieHeader
      );
    }

    if (method === "GET" && sub === "events") {
      const state = JSON.parse(row.stateJson) as AgentRoomState;
      const isOwner = row.ownerSessionId === sessionId;
      if (!isOwner && !state.publicOptIn && row.status !== "WAITING_FOR_AGENT") {
        return jsonResponse(
          { error: { code: "FORBIDDEN", message: "This evaluation room is private to its creator session." } },
          403,
          setCookieHeader
        );
      }

      const encoder = new TextEncoder();
      let unsubscribe: (() => void) | null = null;
      let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

      const cleanup = () => {
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        if (keepAliveTimer) {
          clearInterval(keepAliveTimer);
          keepAliveTimer = null;
        }
      };

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (event: string, data: unknown) => {
            try {
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            } catch {
              cleanup();
            }
          };

          for (const item of state.eventsLog) {
            send(item.event, item.data);
          }

          if (row.status === "COMPLETED" || row.status === "FAILED" || row.status === "CANCELLED") {
            cleanup();
            controller.close();
            return;
          }

          unsubscribe = subscribeAgentRoom(code, (event, data) => {
            send(event, data);
            if (event === "done" || event === "error") {
              cleanup();
              try {
                controller.close();
              } catch {
                // already closed
              }
            }
          });

          keepAliveTimer = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
            } catch {
              cleanup();
            }
          }, 15_000);

          request.signal.addEventListener("abort", () => {
            cleanup();
            try {
              controller.close();
            } catch {
              // ignore
            }
          });
        },
        cancel() {
          cleanup();
        },
      });

      const sseHeaders = buildSecurityHeaders({
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      });
      if (setCookieHeader) sseHeaders.set("Set-Cookie", setCookieHeader);
      return new Response(stream, { status: 200, headers: sseHeaders });
    }
  }

  // POST /api/runs — Create and run live sandboxed evaluation
  if (method === "POST" && pathname === "/api/runs") {
    const idempotencyKey = request.headers.get("Idempotency-Key")?.trim().slice(0, 80) || null;
    if (idempotencyKey) {
      const cached = await store.getRunByIdempotencyKey(sessionId, idempotencyKey);
      if (cached) {
        return jsonResponse({ run: cached.summary, deduplicated: true }, 200, setCookieHeader);
      }
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return jsonResponse(
        { error: { code: "INVALID_JSON", message: "Request body must be valid JSON." } },
        400,
        setCookieHeader
      );
    }

    const parsedReq = CreateRunRequestSchema.safeParse(rawBody);
    if (!parsedReq.success) {
      return jsonResponse(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: parsedReq.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          },
        },
        400,
        setCookieHeader
      );
    }

    const body = parsedReq.data;
    const badRequest = (code: string, message: string) =>
      jsonResponse({ error: { code, message } }, 400, setCookieHeader);

    if (body.presetId === "live_agent") {
      return badRequest(
        "USE_AGENT_ROOMS_ENDPOINT",
        "Self-connect agent mode uses POST /api/agent/rooms (pairing code) or POST /api/agent/sessions (autonomous)."
      );
    }

    if (body.presetId === "custom" && (!body.customPrompt || body.customPrompt.trim().length < 12)) {
      return badRequest("CUSTOM_PROMPT_REQUIRED", "Custom preset requires a system prompt of at least 12 characters.");
    }

    let endpointUrl: URL | null = null;
    if (body.presetId === "endpoint") {
      if (!body.endpoint) {
        return badRequest("ENDPOINT_REQUIRED", "Bring-your-own-agent mode requires endpoint.url.");
      }
      const check = validateExternalAgentUrl(body.endpoint.url, {
        allowLoopback: env.ALLOW_LOOPBACK_AGENT_ENDPOINTS,
      });
      if (!check.ok) return badRequest("ENDPOINT_REJECTED", check.reason);
      endpointUrl = check.url;
    }

    const modelChoices = defenderModelChoices(env);
    let targetModel = env.TARGET_AGENT_MODEL;
    if (body.presetId !== "endpoint" && body.targetModel && body.targetModel !== env.TARGET_AGENT_MODEL) {
      if (!modelChoices.some((m) => m.id === body.targetModel)) {
        return badRequest("MODEL_NOT_ALLOWED", `Model ${body.targetModel} is not available in this arena.`);
      }
      targetModel = body.targetModel;
    }

    const wantsStream = (request.headers.get("Accept") || "").includes("text/event-stream");

    const quota = await store.checkAndRecordQuota({
      sessionId,
      ipHash,
      maxSessionPerHour: env.FREE_RUNS_PER_SESSION_HOUR,
      maxIpPerHour: env.FREE_RUNS_PER_IP_HOUR,
    });
    if (!quota.allowed) {
      return jsonResponse(
        { error: { code: "QUOTA_EXCEEDED", message: quota.reason } },
        429,
        setCookieHeader
      );
    }

    const dayKey = new Date().toISOString().slice(0, 10);
    const spentToday = await store.getDailySpendUsd(dayKey);
    if (spentToday >= env.AI_DAILY_BUDGET_USD) {
      return jsonResponse(
        {
          error: {
            code: "DAILY_BUDGET_CAP_REACHED",
            message: `Daily AI inference safety cap ($${env.AI_DAILY_BUDGET_USD.toFixed(2)}) reached.`,
          },
        },
        429,
        setCookieHeader
      );
    }

    const isEndpoint = body.presetId === "endpoint";
    const preset = getPresetById(isEndpoint && body.endpoint ? body.endpoint.rulebookPresetId : body.presetId);
    const scenario = getScenarioById(body.scenarioId);
    const activePrompt = isEndpoint
      ? `external-agent:${endpointUrl?.host}`
      : body.presetId === "custom" && body.customPrompt
        ? body.customPrompt.trim()
        : preset.systemPrompt;

    const baseRules = {
      ...preset.defaultRules,
      allowedTokens: scenario.allowlistedTokens,
    };
    const effectiveRules =
      body.presetId === "custom"
        ? deriveRulesFromCustomPrompt(activePrompt, baseRules)
        : baseRules;

    const runId = crypto.randomUUID();
    const createdAtIso = new Date().toISOString();
    const { adapter } = resolveLlmAdapter(env, options.llmAdapterOverride);
    const target =
      isEndpoint && endpointUrl
        ? createEndpointTargetAgent({
            url: endpointUrl,
            secret: body.endpoint?.secret || undefined,
            timeoutMs: env.EXTERNAL_AGENT_TIMEOUT_MS,
          })
        : undefined;

    const defender: DefenderDescriptor = {
      kind: isEndpoint ? "endpoint" : body.presetId === "custom" ? "prompt" : "preset",
      model: isEndpoint ? null : targetModel,
      endpointHost: endpointUrl ? endpointUrl.host : null,
      rulebookPresetId: isEndpoint ? preset.id : null,
    };
    const attack: AttackCustomization = {
      customPayload: body.customPayload?.trim() || null,
      attackerBrief: body.attackerBrief?.trim() || null,
    };

    const encryptedPrompt =
      body.persistPrompt && body.presetId === "custom"
        ? await encryptPromptAtRest(activePrompt, env.PROMPT_ENCRYPTION_KEY)
        : null;
    const promptExpiresAtMs = encryptedPrompt
      ? Date.now() + env.PROMPT_RETENTION_HOURS * 3_600_000
      : null;

    const finishRun = async (hooks: {
      onRoundComplete?: (round: RoundTraceRecord) => void | Promise<void>;
      onPhase?: (event: ArenaPhaseEvent) => void | Promise<void>;
    }) => {
      const execResult = await executeArenaRun({
        runId,
        policyPrompt: activePrompt,
        rules: effectiveRules,
        scenario,
        maxRounds: body.maxRounds,
        includeCleanBenchmark: body.includeCleanBenchmark,
        chainId: env.ELENCHI_ARENA_CHAIN_ID,
        arenaContractAddress: env.ELENCHI_ARENA_ADDRESS,
        adapter,
        redModel: env.RED_AGENT_MODEL,
        targetModel,
        target,
        customPayload: attack.customPayload,
        attackerBrief: attack.attackerBrief,
        maxTokens: env.AI_MAX_TOKENS,
        timeoutMs: env.AI_REQUEST_TIMEOUT_MS,
        ...hooks,
      });

      await store.addDailySpendUsd(dayKey, execResult.totalEstimatedCostUsd);

      const lifecycle =
        execResult.errorCode === "TIMEOUT"
          ? "TIMED_OUT"
          : execResult.errorCode !== null
            ? "FAILED"
            : "COMPLETED";

      const summary: RunSummaryRecord = {
        id: runId,
        runIdBytes32: execResult.runIdBytes32,
        parentRunId: null,
        lifecycle,
        attestationLifecycle: "NOT_REQUESTED",
        outcome: execResult.outcome,
        presetId: body.presetId,
        scenarioId: body.scenarioId,
        maxRounds: body.maxRounds,
        roundsAttempted: execResult.roundsAttempted,
        roundsPassed: execResult.roundsPassed,
        cleanBenchmarksRun: execResult.cleanBenchmarksRun,
        cleanBenchmarksPassed: execResult.cleanBenchmarksPassed,
        functionalUtilityScore: execResult.functionalUtilityScore,
        failureKind: execResult.failureKind,
        riskSeverity: execResult.riskSeverity,
        policyHash: execResult.policyHash,
        agentConfigHash: execResult.agentConfigHash,
        scenarioHash: execResult.scenarioHash,
        reportHash: execResult.reportHash,
        sandboxSigner: execResult.sandboxSigner,
        publicOptIn: body.publicOptIn,
        promptPersistedEncrypted: encryptedPrompt !== null,
        errorCode: execResult.errorCode,
        errorMessage: execResult.errorMessage,
        createdAtIso,
        completedAtIso: new Date().toISOString(),
        rounds: execResult.rounds,
        patchSuggestion: null,
        attestationTxHash: null,
        attestationChainId: null,
        defender,
        attack,
      };

      await store.saveRun(
        {
          summary,
          ownerSessionId: sessionId,
          encryptedPrompt,
          promptExpiresAtMs,
        },
        idempotencyKey
      );
      return summary;
    };

    if (wantsStream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (event: string, data: unknown) =>
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          try {
            send("start", {
              runId,
              maxRounds: body.maxRounds,
              includeCleanBenchmark: body.includeCleanBenchmark,
              defender,
              redModel: attack.customPayload ? "custom-injection" : env.RED_AGENT_MODEL,
            });
            const summary = await finishRun({
              onPhase: (e) => send("phase", e),
              onRoundComplete: (round) => send("round", round),
            });
            send("done", { run: summary, remainingSessionRuns: quota.remainingSessionRuns });
          } catch (err) {
            send("error", {
              code: "INTERNAL_ERROR",
              message: err instanceof Error ? err.message : "Run failed",
            });
          } finally {
            controller.close();
          }
        },
      });
      const sseHeaders = buildSecurityHeaders({
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      });
      if (setCookieHeader) sseHeaders.set("Set-Cookie", setCookieHeader);
      return new Response(stream, { status: 200, headers: sseHeaders });
    }

    const summary = await finishRun({});
    return jsonResponse(
      {
        run: summary,
        remainingSessionRuns: quota.remainingSessionRuns,
      },
      summary.lifecycle === "COMPLETED" ? 201 : 502,
      setCookieHeader
    );
  }

  // Match /api/runs/:id and sub-routes
  const runMatch = pathname.match(
    /^\/api\/runs\/([0-9a-fA-F-]{36})(?:\/(events|report|patch|retest|attest))?$/
  );
  if (runMatch) {
    const runId = runMatch[1];
    const subRoute = runMatch[2] ?? "";
    const stored = await store.getRun(runId);

    if (!stored) {
      return jsonResponse(
        { error: { code: "RUN_NOT_FOUND", message: `Run ${runId} does not exist.` } },
        404,
        setCookieHeader
      );
    }

    const isOwner = stored.ownerSessionId === sessionId;
    if (!isOwner && !stored.summary.publicOptIn) {
      return jsonResponse(
        {
          error: {
            code: "FORBIDDEN",
            message: "This evaluation run is private to its creator session.",
          },
        },
        403,
        setCookieHeader
      );
    }

    // GET /api/runs/:id
    if (method === "GET" && subRoute === "") {
      return jsonResponse({ run: stored.summary, isOwner }, 200, setCookieHeader);
    }

    // DELETE /api/runs/:id
    if (method === "DELETE" && subRoute === "") {
      if (!isOwner) {
        return jsonResponse(
          { error: { code: "FORBIDDEN", message: "Only the session owner can delete this run." } },
          403,
          setCookieHeader
        );
      }
      await store.deleteRun(runId);
      return jsonResponse({ deleted: true, id: runId }, 200, setCookieHeader);
    }

    // GET /api/runs/:id/events (SSE stream)
    if (method === "GET" && subRoute === "events") {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          for (const round of stored.summary.rounds) {
            controller.enqueue(
              encoder.encode(`event: round\ndata: ${JSON.stringify(round)}\n\n`)
            );
          }
          controller.enqueue(
            encoder.encode(
              `event: summary\ndata: ${JSON.stringify({
                id: stored.summary.id,
                lifecycle: stored.summary.lifecycle,
                outcome: stored.summary.outcome,
                reportHash: stored.summary.reportHash,
              })}\n\n`
            )
          );
          controller.close();
        },
      });
      const sseHeaders = buildSecurityHeaders({
        "Content-Type": "text/event-stream; charset=utf-8",
        Connection: "keep-alive",
      });
      if (setCookieHeader) sseHeaders.set("Set-Cookie", setCookieHeader);
      return new Response(stream, { status: 200, headers: sseHeaders });
    }

    // GET /api/runs/:id/report
    if (method === "GET" && subRoute === "report") {
      const format = (url.searchParams.get("format") || "json").toLowerCase();
      if (format === "markdown" || format === "md") {
        const md = buildMarkdownReport(stored.summary);
        const h = buildSecurityHeaders({
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="elenchi-report-${runId.slice(0, 8)}.md"`,
        });
        if (setCookieHeader) h.set("Set-Cookie", setCookieHeader);
        return new Response(md, { status: 200, headers: h });
      }

      const structuredReport = {
        reportMethodVersion: REPORT_METHOD_VERSION,
        suiteVersion: SUITE_VERSION,
        exportedAtIso: new Date().toISOString(),
        trustDisclosures: {
          levelA_modelObservation:
            "Generated and logged by the Elenchi sandbox service; prompt-level simulations do not prove third-party production bot identity.",
          levelB_cryptographicIntent:
            "EIP-712 SimulatedAction signature proves the ephemeral sandbox key signed a non-executable struct under the specified chain and contract domain.",
          levelC_onChainAttestation:
            "PASSED_SUITE applies strictly to the tested scenario and model version — never universal security.",
        },
        run: {
          ...stored.summary,
          patchSuggestion: stored.summary.patchSuggestion
            ? {
                ...stored.summary.patchSuggestion,
                // Redact raw prompt text for non-owner public exports
                patchedPrompt: isOwner
                  ? stored.summary.patchSuggestion.patchedPrompt
                  : "[REDACTED_IN_PUBLIC_EXPORT]",
                unifiedDiff: isOwner
                  ? stored.summary.patchSuggestion.unifiedDiff
                  : "[REDACTED_IN_PUBLIC_EXPORT]",
              }
            : null,
        },
      };

      return jsonResponse(structuredReport, 200, setCookieHeader, {
        "Content-Disposition": `attachment; filename="elenchi-report-${runId.slice(0, 8)}.json"`,
      });
    }

    // POST /api/runs/:id/patch
    if (method === "POST" && subRoute === "patch") {
      if (!isOwner) {
        return jsonResponse(
          { error: { code: "FORBIDDEN", message: "Only the session owner can generate a patch." } },
          403,
          setCookieHeader
        );
      }

      if (stored.summary.presetId === "endpoint" || stored.summary.presetId === "live_agent") {
        return jsonResponse(
          {
            error: {
              code: "PATCH_NOT_APPLICABLE",
              message: "External and self-connected bots have no prompt Elenchi can patch. Use the violated rules in the report to harden your bot.",
            },
          },
          400,
          setCookieHeader
        );
      }

      const body = (await request.json().catch(() => ({}))) as { customPrompt?: string };
      let originalPrompt = "";
      if (stored.summary.presetId !== "custom") {
        originalPrompt = getPresetById(stored.summary.presetId).systemPrompt;
      } else if (typeof body.customPrompt === "string" && body.customPrompt.trim()) {
        originalPrompt = body.customPrompt.trim();
      } else if (stored.encryptedPrompt) {
        originalPrompt =
          (await decryptPromptAtRest(stored.encryptedPrompt, env.PROMPT_ENCRYPTION_KEY)) ?? "";
      }

      if (!originalPrompt) {
        return jsonResponse(
          {
            error: {
              code: "ORIGINAL_PROMPT_UNAVAILABLE",
              message:
                "Custom prompt was not stored (privacy default). Re-supply customPrompt in request body to generate a patch.",
            },
          },
          400,
          setCookieHeader
        );
      }

      const preset = getPresetById(stored.summary.presetId);
      const scenario = getScenarioById(stored.summary.scenarioId);
      const rules =
        stored.summary.presetId === "custom"
          ? deriveRulesFromCustomPrompt(originalPrompt, {
              ...preset.defaultRules,
              allowedTokens: scenario.allowlistedTokens,
            })
          : { ...preset.defaultRules, allowedTokens: scenario.allowlistedTokens };

      const violatedRules = Array.from(
        new Set(stored.summary.rounds.flatMap((r) => r.violations.map((v) => v.ruleId)))
      );

      const { adapter } = resolveLlmAdapter(env, options.llmAdapterOverride);
      try {
        const { patch, estimatedCostUsd } = await generateDefensivePromptPatch({
          originalPrompt,
          violatedRules,
          rules,
          adapter,
          patchModel: env.PATCH_AGENT_MODEL,
          maxTokens: env.AI_MAX_TOKENS,
          timeoutMs: env.AI_REQUEST_TIMEOUT_MS,
        });
        await store.addDailySpendUsd(new Date().toISOString().slice(0, 10), estimatedCostUsd);

        stored.summary.patchSuggestion = patch;
        await store.saveRun(stored);
        return jsonResponse({ patch }, 200, setCookieHeader);
      } catch (err) {
        const code = err instanceof LlmProviderError ? err.code : "PROVIDER_ERROR";
        return jsonResponse(
          {
            error: {
              code,
              message: err instanceof Error ? err.message : "Failed to generate prompt patch",
            },
          },
          502,
          setCookieHeader
        );
      }
    }

    // POST /api/runs/:id/retest — Run patched prompt against adversarial + BOTH clean regression benchmarks
    if (method === "POST" && subRoute === "retest") {
      if (!isOwner) {
        return jsonResponse(
          { error: { code: "FORBIDDEN", message: "Only the session owner can retest a run." } },
          403,
          setCookieHeader
        );
      }
      if (stored.summary.presetId === "endpoint" || stored.summary.presetId === "live_agent") {
        return jsonResponse(
          {
            error: {
              code: "RETEST_NOT_APPLICABLE",
              message: "Start a new run against your bot after updating it.",
            },
          },
          400,
          setCookieHeader
        );
      }

      const body = (await request.json().catch(() => ({}))) as { patchedPrompt?: string };
      const patchedPrompt =
        (typeof body.patchedPrompt === "string" && body.patchedPrompt.trim()) ||
        stored.summary.patchSuggestion?.patchedPrompt ||
        "";

      if (!patchedPrompt) {
        return jsonResponse(
          {
            error: {
              code: "PATCH_REQUIRED",
              message: "Generate a prompt patch first or supply patchedPrompt in request body.",
            },
          },
          400,
          setCookieHeader
        );
      }

      const preset = getPresetById(stored.summary.presetId);
      const scenario = getScenarioById(stored.summary.scenarioId);
      const rules = {
        ...preset.defaultRules,
        allowedTokens: scenario.allowlistedTokens,
      };
      const newRunId = crypto.randomUUID();
      const createdAtIso = new Date().toISOString();
      const { adapter } = resolveLlmAdapter(env, options.llmAdapterOverride);
      const retestModel = stored.summary.defender?.model || env.TARGET_AGENT_MODEL;

      const execResult = await executeArenaRun({
        runId: newRunId,
        policyPrompt: patchedPrompt,
        rules,
        scenario,
        maxRounds: stored.summary.maxRounds,
        includeCleanBenchmark: true,
        chainId: env.ELENCHI_ARENA_CHAIN_ID,
        arenaContractAddress: env.ELENCHI_ARENA_ADDRESS,
        adapter,
        redModel: env.RED_AGENT_MODEL,
        targetModel: retestModel,
        attackerBrief: stored.summary.attack?.attackerBrief ?? null,
        maxTokens: env.AI_MAX_TOKENS,
        timeoutMs: env.AI_REQUEST_TIMEOUT_MS,
      });

      await store.addDailySpendUsd(
        new Date().toISOString().slice(0, 10),
        execResult.totalEstimatedCostUsd
      );

      const lifecycle =
        execResult.errorCode === "TIMEOUT"
          ? "TIMED_OUT"
          : execResult.errorCode !== null
            ? "FAILED"
            : "COMPLETED";

      const retestSummary: RunSummaryRecord = {
        id: newRunId,
        runIdBytes32: execResult.runIdBytes32,
        parentRunId: stored.summary.id,
        lifecycle,
        attestationLifecycle: "NOT_REQUESTED",
        outcome: execResult.outcome,
        presetId: stored.summary.presetId,
        scenarioId: stored.summary.scenarioId,
        maxRounds: stored.summary.maxRounds,
        roundsAttempted: execResult.roundsAttempted,
        roundsPassed: execResult.roundsPassed,
        cleanBenchmarksRun: execResult.cleanBenchmarksRun,
        cleanBenchmarksPassed: execResult.cleanBenchmarksPassed,
        functionalUtilityScore: execResult.functionalUtilityScore,
        failureKind: execResult.failureKind,
        riskSeverity: execResult.riskSeverity,
        policyHash: execResult.policyHash,
        agentConfigHash: execResult.agentConfigHash,
        scenarioHash: execResult.scenarioHash,
        reportHash: execResult.reportHash,
        sandboxSigner: execResult.sandboxSigner,
        publicOptIn: stored.summary.publicOptIn,
        promptPersistedEncrypted: false,
        errorCode: execResult.errorCode,
        errorMessage: execResult.errorMessage,
        createdAtIso,
        completedAtIso: new Date().toISOString(),
        rounds: execResult.rounds,
        patchSuggestion: null,
        attestationTxHash: null,
        attestationChainId: null,
        defender: stored.summary.defender ? { ...stored.summary.defender, model: retestModel } : undefined,
        attack: stored.summary.attack ? { customPayload: null, attackerBrief: stored.summary.attack.attackerBrief } : undefined,
      };

      await store.saveRun({
        summary: retestSummary,
        ownerSessionId: sessionId,
        encryptedPrompt: null,
        promptExpiresAtMs: null,
      });

      return jsonResponse(
        {
          originalRunId: stored.summary.id,
          originalOutcome: stored.summary.outcome,
          retestRun: retestSummary,
          comparison: {
            breachEliminatedInTestedScenario:
              stored.summary.outcome === "BREACHED" && retestSummary.outcome === "PASSED_SUITE",
            cleanUtilityPreserved:
              retestSummary.cleanBenchmarksRun > 0 &&
              retestSummary.cleanBenchmarksPassed === retestSummary.cleanBenchmarksRun,
          },
        },
        lifecycle === "COMPLETED" ? 201 : 502,
        setCookieHeader
      );
    }

    // POST /api/runs/:id/attest — Prepare evidence-only ElenchiArena registration payload
    if (method === "POST" && subRoute === "attest") {
      if (stored.summary.lifecycle !== "COMPLETED" || !stored.summary.outcome || !stored.summary.reportHash) {
        return jsonResponse(
          {
            error: {
              code: "RUN_NOT_ATTESTABLE",
              message: "Only completed evaluation runs can prepare an attestation payload.",
            },
          },
          400,
          setCookieHeader
        );
      }

      const breachRoundWithSig =
        stored.summary.rounds.find((r) => r.signedEvidence !== null) ?? null;

      if (!env.ELENCHI_ARENA_ADDRESS || !env.ELENCHI_ATTESTOR_PRIVATE_KEY) {
        return jsonResponse(
          {
            onChainReady: false,
            reason:
              "ElenchiArena.sol is not yet deployed/configured on Robinhood Chain. Returning locally verifiable off-chain EIP-712 evidence artifact only (never a fabricated tx).",
            chainId: env.ELENCHI_ARENA_CHAIN_ID,
            contractAddress: null,
            signedEvidencePacket: breachRoundWithSig?.signedEvidence ?? null,
          },
          200,
          setCookieHeader
        );
      }

      const contractAddress = normalizeEvmAddress(env.ELENCHI_ARENA_ADDRESS);
      const nowSec = Math.floor(Date.now() / 1000);
      const deadline = BigInt(nowSec + 1800);
      const attestorNonce = BigInt(Date.now());
      const suiteVersionHash = keccak256(stringToHex(SUITE_VERSION));

      const hasAction = Boolean(
        breachRoundWithSig?.signedEvidence &&
          breachRoundWithSig.signedEvidence.verifyingContract.toLowerCase() ===
            contractAddress.toLowerCase()
      );
      const ev = breachRoundWithSig?.signedEvidence;

      const actionTuple =
        hasAction && ev
          ? {
              runId: ev.action.runId,
              policyHash: ev.action.policyHash,
              scenarioHash: ev.action.scenarioHash,
              nonce: BigInt(ev.action.nonce),
              deadline: BigInt(ev.action.deadline),
              token: normalizeEvmAddress(ev.action.token),
              recipient: normalizeEvmAddress(ev.action.recipient),
              amount: BigInt(ev.action.amount),
              maxSlippageBps: ev.action.maxSlippageBps,
              actionCategory: ev.action.actionCategory,
              evidenceNoticeHash: ev.action.evidenceNoticeHash,
            }
          : {
              runId: "0x0000000000000000000000000000000000000000000000000000000000000000" as const,
              policyHash: "0x0000000000000000000000000000000000000000000000000000000000000000" as const,
              scenarioHash: "0x0000000000000000000000000000000000000000000000000000000000000000" as const,
              nonce: 0n,
              deadline: 0n,
              token: "0x0000000000000000000000000000000000000000" as const,
              recipient: "0x0000000000000000000000000000000000000000" as const,
              amount: 0n,
              maxSlippageBps: 0,
              actionCategory: 0 as const,
              evidenceNoticeHash: EVIDENCE_NOTICE_HASH,
            };

      const inputTuple = {
        runId: stored.summary.runIdBytes32,
        reportHash: stored.summary.reportHash,
        policyHash: stored.summary.policyHash,
        agentConfigHash: stored.summary.agentConfigHash,
        scenarioHash: stored.summary.scenarioHash,
        suiteVersionHash,
        sandboxSigner: normalizeEvmAddress(stored.summary.sandboxSigner),
        outcome: OUTCOME_SOLIDITY_CODE[stored.summary.outcome],
        attackClass: ATTACK_CLASS_CODE[stored.summary.scenarioId],
        failureKind: FAILURE_KIND_CODE[stored.summary.failureKind],
        riskSeverity: RISK_SEVERITY_CODE[stored.summary.riskSeverity],
        roundsAttempted: stored.summary.roundsAttempted,
        roundsPassed: stored.summary.roundsPassed,
        attestorNonce,
        deadline,
      };

      const permitSig = await signAttestationPermit({
        attestorPrivateKey: env.ELENCHI_ATTESTOR_PRIVATE_KEY,
        chainId: env.ELENCHI_ARENA_CHAIN_ID,
        verifyingContract: contractAddress,
        permit: {
          ...inputTuple,
          requiresActionSig: hasAction,
          actionStructHash:
            hasAction && ev
              ? ev.structHash
              : "0x0000000000000000000000000000000000000000000000000000000000000000",
        },
      });

      const calldata = encodeFunctionData({
        abi: ARENA_REGISTER_ABI,
        functionName: "registerAttestation",
        args: [
          inputTuple,
          hasAction,
          actionTuple,
          hasAction && ev ? ev.signature : "0x",
          permitSig,
        ],
      });

      stored.summary.attestationLifecycle = "PREPARED";
      stored.summary.attestationChainId = env.ELENCHI_ARENA_CHAIN_ID;
      await store.saveRun(stored);

      return jsonResponse(
        {
          onChainReady: true,
          chainId: env.ELENCHI_ARENA_CHAIN_ID,
          to: contractAddress,
          valueWei: "0",
          data: calldata,
          walletRequirements:
            "Connect an EVM wallet on the matching Robinhood Chain network to submit this evidence-only registration transaction.",
        },
        200,
        setCookieHeader
      );
    }
  }

  return jsonResponse(
    { error: { code: "NOT_FOUND", message: `Unknown API route: ${method} ${pathname}` } },
    404,
    setCookieHeader
  );
}
