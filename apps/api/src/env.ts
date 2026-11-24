export interface ElenchiEnv {
  APP_URL: string;
  CHAIN_ID: number;
  RPC_URL: string;
  RPC_FALLBACK_URL: string;
  EXPLORER_URL: string;
  TESTNET_CHAIN_ID: number;
  TESTNET_RPC_URL: string;
  TESTNET_EXPLORER_URL: string;

  ELENCHI_ARENA_ADDRESS: `0x${string}` | null;
  ELENCHI_ARENA_CHAIN_ID: number;
  ELENCHI_ATTESTOR_PRIVATE_KEY: `0x${string}` | null;

  TOKEN_LAUNCH_STATE: "PRELAUNCH" | "LIVE";
  ELENCHI_TOKEN_ADDRESS: `0x${string}` | null;
  ELENCHI_TOKEN_LAUNCH_TX: `0x${string}` | null;
  ELENCHI_PONS_VERSION: "MAIN_POOL" | "V2_CURVE" | null;
  ELENCHI_PONS_FACTORY: `0x${string}` | null;
  ELENCHI_PONS_TRADING_URL: string | null;

  AI_PROVIDER: "openrouter" | "openai" | "workers-ai";
  AI_BASE_URL: string;
  AI_API_KEY: string;
  RED_AGENT_MODEL: string;
  TARGET_AGENT_MODEL: string;
  PATCH_AGENT_MODEL: string;
  AI_MAX_TOKENS: number;
  AI_REQUEST_TIMEOUT_MS: number;
  AI_DAILY_BUDGET_USD: number;

  SESSION_HMAC_SECRET: string;
  PROMPT_ENCRYPTION_KEY: string;
  FREE_RUNS_PER_SESSION_HOUR: number;
  FREE_RUNS_PER_IP_HOUR: number;
  PROMPT_RETENTION_HOURS: number;
  /** Development only: lets external defender bots live on loopback addresses. */
  ALLOW_LOOPBACK_AGENT_ENDPOINTS: boolean;
  EXTERNAL_AGENT_TIMEOUT_MS: number;

  /** Optional Cloudflare Workers AI binding (`env.AI`) */
  AI?: {
    run(model: string, input: Record<string, unknown>): Promise<unknown>;
  };
}

function optHexAddress(val: unknown): `0x${string}` | null {
  if (typeof val !== "string") return null;
  const trimmed = val.trim();
  return /^0x[a-fA-F0-9]{40}$/.test(trimmed) ? (trimmed as `0x${string}`) : null;
}

function optHexBytes32(val: unknown): `0x${string}` | null {
  if (typeof val !== "string") return null;
  const trimmed = val.trim();
  return /^0x[a-fA-F0-9]{64}$/.test(trimmed) ? (trimmed as `0x${string}`) : null;
}

function intOr(val: unknown, fallback: number): number {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string" && val.trim()) {
    const parsed = Number.parseInt(val.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function floatOr(val: unknown, fallback: number): number {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string" && val.trim()) {
    const parsed = Number.parseFloat(val.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function resolveEnv(raw: Record<string, unknown> = {}): ElenchiEnv {
  const tokenAddr = optHexAddress(raw.ELENCHI_TOKEN_ADDRESS);
  const launchStateRaw = String(raw.TOKEN_LAUNCH_STATE ?? "PRELAUNCH").toUpperCase();
  const launchState =
    launchStateRaw === "LIVE" && tokenAddr !== null ? "LIVE" : "PRELAUNCH";

  const ponsVerRaw = String(raw.ELENCHI_PONS_VERSION ?? "").toUpperCase();
  const ponsVersion =
    ponsVerRaw === "MAIN_POOL" || ponsVerRaw === "V2_CURVE" ? ponsVerRaw : null;

  const aiProviderRaw = String(raw.AI_PROVIDER ?? "").toLowerCase();
  const hasWorkersAi = Boolean(raw.AI && typeof (raw.AI as { run?: unknown }).run === "function");
  const hasApiKey = typeof raw.AI_API_KEY === "string" && raw.AI_API_KEY.trim().length > 0;

  let aiProvider: "openrouter" | "openai" | "workers-ai" = "openrouter";
  if (aiProviderRaw === "workers-ai" || (!hasApiKey && hasWorkersAi)) {
    aiProvider = "workers-ai";
  } else if (aiProviderRaw === "openai") {
    aiProvider = "openai";
  }

  return {
    APP_URL: String(raw.APP_URL || "https://elenchi.dev"),
    CHAIN_ID: intOr(raw.CHAIN_ID, 4663),
    RPC_URL: String(raw.RPC_URL || "https://rpc.mainnet.chain.robinhood.com"),
    RPC_FALLBACK_URL: String(
      raw.RPC_FALLBACK_URL || "https://rpc.mainnet.chain.robinhood.com"
    ),
    EXPLORER_URL: String(raw.EXPLORER_URL || "https://robinhoodchain.blockscout.com"),
    TESTNET_CHAIN_ID: intOr(raw.TESTNET_CHAIN_ID, 46630),
    TESTNET_RPC_URL: String(
      raw.TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com"
    ),
    TESTNET_EXPLORER_URL: String(
      raw.TESTNET_EXPLORER_URL || "https://explorer.testnet.chain.robinhood.com"
    ),

    ELENCHI_ARENA_ADDRESS: optHexAddress(raw.ELENCHI_ARENA_ADDRESS),
    ELENCHI_ARENA_CHAIN_ID: intOr(raw.ELENCHI_ARENA_CHAIN_ID, 46630),
    ELENCHI_ATTESTOR_PRIVATE_KEY: optHexBytes32(raw.ELENCHI_ATTESTOR_PRIVATE_KEY),

    TOKEN_LAUNCH_STATE: launchState,
    ELENCHI_TOKEN_ADDRESS: launchState === "LIVE" ? tokenAddr : null,
    ELENCHI_TOKEN_LAUNCH_TX: optHexBytes32(raw.ELENCHI_TOKEN_LAUNCH_TX),
    ELENCHI_PONS_VERSION: ponsVersion,
    ELENCHI_PONS_FACTORY: optHexAddress(raw.ELENCHI_PONS_FACTORY),
    ELENCHI_PONS_TRADING_URL:
      typeof raw.ELENCHI_PONS_TRADING_URL === "string" &&
      raw.ELENCHI_PONS_TRADING_URL.startsWith("https://ponsfamily.com/")
        ? raw.ELENCHI_PONS_TRADING_URL.trim()
        : null,

    AI_PROVIDER: aiProvider,
    AI_BASE_URL: String(raw.AI_BASE_URL || "https://openrouter.ai/api/v1"),
    AI_API_KEY: typeof raw.AI_API_KEY === "string" ? raw.AI_API_KEY.trim() : "",
    RED_AGENT_MODEL: String(
      raw.RED_AGENT_MODEL ||
        (aiProvider === "workers-ai"
          ? "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
          : "deepseek/deepseek-chat-v3-0324")
    ),
    TARGET_AGENT_MODEL: String(
      raw.TARGET_AGENT_MODEL ||
        (aiProvider === "workers-ai"
          ? "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
          : "deepseek/deepseek-chat-v3-0324")
    ),
    PATCH_AGENT_MODEL: String(
      raw.PATCH_AGENT_MODEL ||
        (aiProvider === "workers-ai"
          ? "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
          : "deepseek/deepseek-chat-v3-0324")
    ),
    AI_MAX_TOKENS: intOr(raw.AI_MAX_TOKENS, 650),
    AI_REQUEST_TIMEOUT_MS: intOr(raw.AI_REQUEST_TIMEOUT_MS, 22000),
    AI_DAILY_BUDGET_USD: floatOr(raw.AI_DAILY_BUDGET_USD, 5.0),

    SESSION_HMAC_SECRET: String(
      raw.SESSION_HMAC_SECRET || "elenchi-dev-session-hmac-secret-override-in-prod"
    ),
    PROMPT_ENCRYPTION_KEY: String(
      raw.PROMPT_ENCRYPTION_KEY || "elenchi-dev-prompt-aes-gcm-key-override-in-prod"
    ),
    FREE_RUNS_PER_SESSION_HOUR: intOr(raw.FREE_RUNS_PER_SESSION_HOUR, 12),
    FREE_RUNS_PER_IP_HOUR: intOr(raw.FREE_RUNS_PER_IP_HOUR, 20),
    PROMPT_RETENTION_HOURS: intOr(raw.PROMPT_RETENTION_HOURS, 24),
    ALLOW_LOOPBACK_AGENT_ENDPOINTS: String(raw.ALLOW_LOOPBACK_AGENT_ENDPOINTS ?? "").toLowerCase() === "true",
    EXTERNAL_AGENT_TIMEOUT_MS: intOr(raw.EXTERNAL_AGENT_TIMEOUT_MS, 15000),

    AI: hasWorkersAi
      ? (raw.AI as { run(model: string, input: Record<string, unknown>): Promise<unknown> })
      : undefined,
  };
}
