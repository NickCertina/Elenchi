import {
  createPublicClient,
  fallback,
  formatUnits,
  http,
  parseAbi,
  parseAbiItem,
} from "viem";
import { normalizeEvmAddress } from "@elenchi/eip712";
import type { ElenchiEnv } from "./env";

const ERC20_METADATA_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
]);

const ATTESTATION_EVENT = parseAbiItem(
  "event AttestationRegistered(bytes32 indexed runId, uint8 indexed outcome, uint8 indexed attackClass, address sandboxSigner, address attestor, bytes32 reportHash, bool hasVerifiedActionSig)"
);

function buildRpcClient(primaryUrl: string, fallbackUrl?: string) {
  const transports =
    fallbackUrl && fallbackUrl !== primaryUrl
      ? fallback([http(primaryUrl, { timeout: 8000 }), http(fallbackUrl, { timeout: 8000 })])
      : http(primaryUrl, { timeout: 8000 });
  return createPublicClient({ transport: transports });
}

export interface ChainEndpointStatus {
  label: string;
  expectedChainId: number;
  observedChainId: number | null;
  healthy: boolean;
  latestBlock: string | null;
  latencyMs: number;
  explorerUrl: string;
  error: string | null;
}

export async function checkRobinhoodChainHealth(env: ElenchiEnv): Promise<{
  checkedAtIso: string;
  mainnet: ChainEndpointStatus;
  testnet: ChainEndpointStatus;
  arenaContract: {
    deployed: boolean;
    address: `0x${string}` | null;
    chainId: number;
    explorerUrl: string | null;
  };
}> {
  async function probe(
    label: string,
    expectedChainId: number,
    rpcUrl: string,
    fallbackUrl: string | undefined,
    explorerUrl: string
  ): Promise<ChainEndpointStatus> {
    const t0 = Date.now();
    try {
      const client = buildRpcClient(rpcUrl, fallbackUrl);
      const [chainIdNum, blockNum] = await Promise.all([
        client.getChainId(),
        client.getBlockNumber(),
      ]);
      const healthy = chainIdNum === expectedChainId;
      return {
        label,
        expectedChainId,
        observedChainId: chainIdNum,
        healthy,
        latestBlock: blockNum.toString(),
        latencyMs: Date.now() - t0,
        explorerUrl,
        error: healthy ? null : `Observed chainId ${chainIdNum} != expected ${expectedChainId}`,
      };
    } catch (err) {
      return {
        label,
        expectedChainId,
        observedChainId: null,
        healthy: false,
        latestBlock: null,
        latencyMs: Date.now() - t0,
        explorerUrl,
        error: err instanceof Error ? err.message : "RPC unreachable",
      };
    }
  }

  const [mainnet, testnet] = await Promise.all([
    probe("Robinhood Chain Mainnet", env.CHAIN_ID, env.RPC_URL, env.RPC_FALLBACK_URL, env.EXPLORER_URL),
    probe("Robinhood Chain Testnet", env.TESTNET_CHAIN_ID, env.TESTNET_RPC_URL, undefined, env.TESTNET_EXPLORER_URL),
  ]);

  const arenaExplorerBase =
    env.ELENCHI_ARENA_CHAIN_ID === env.CHAIN_ID ? env.EXPLORER_URL : env.TESTNET_EXPLORER_URL;

  return {
    checkedAtIso: new Date().toISOString(),
    mainnet,
    testnet,
    arenaContract: {
      deployed: env.ELENCHI_ARENA_ADDRESS !== null,
      address: env.ELENCHI_ARENA_ADDRESS
        ? normalizeEvmAddress(env.ELENCHI_ARENA_ADDRESS)
        : null,
      chainId: env.ELENCHI_ARENA_CHAIN_ID,
      explorerUrl: env.ELENCHI_ARENA_ADDRESS
        ? `${arenaExplorerBase.replace(/\/+$/, "")}/address/${normalizeEvmAddress(env.ELENCHI_ARENA_ADDRESS)}`
        : null,
    },
  };
}

export interface OnChainAttestationItem {
  runId: `0x${string}`;
  outcomeCode: number;
  outcomeLabel: "BREACHED" | "PASSED_SUITE" | "INCONCLUSIVE" | "UNKNOWN";
  attackClassCode: number;
  sandboxSigner: `0x${string}`;
  attestor: `0x${string}`;
  reportHash: `0x${string}`;
  hasVerifiedActionSig: boolean;
  blockNumber: string;
  confirmations: string;
  txHash: `0x${string}`;
  explorerTxUrl: string;
}

export async function fetchOnChainAttestations(env: ElenchiEnv): Promise<{
  deployed: boolean;
  chainId: number;
  contractAddress: `0x${string}` | null;
  minConfirmations: number;
  items: OnChainAttestationItem[];
  error: string | null;
}> {
  const minConfirmations = 2;
  if (!env.ELENCHI_ARENA_ADDRESS) {
    return {
      deployed: false,
      chainId: env.ELENCHI_ARENA_CHAIN_ID,
      contractAddress: null,
      minConfirmations,
      items: [],
      error: null,
    };
  }

  const isMainnet = env.ELENCHI_ARENA_CHAIN_ID === env.CHAIN_ID;
  const rpcUrl = isMainnet ? env.RPC_URL : env.TESTNET_RPC_URL;
  const explorerBase = (isMainnet ? env.EXPLORER_URL : env.TESTNET_EXPLORER_URL).replace(/\/+$/, "");
  const contractAddr = normalizeEvmAddress(env.ELENCHI_ARENA_ADDRESS);

  try {
    const client = buildRpcClient(rpcUrl);
    const latestBlock = await client.getBlockNumber();
    const fromBlock = latestBlock > 25_000n ? latestBlock - 25_000n : 0n;

    const logs = await client.getLogs({
      address: contractAddr,
      event: ATTESTATION_EVENT,
      fromBlock,
      toBlock: latestBlock,
    });

    const outcomeMap: Record<number, OnChainAttestationItem["outcomeLabel"]> = {
      1: "BREACHED",
      2: "PASSED_SUITE",
      3: "INCONCLUSIVE",
    };

    const items: OnChainAttestationItem[] = logs
      .slice(-25)
      .reverse()
      .map((log) => {
        const confs = latestBlock >= (log.blockNumber ?? 0n)
          ? latestBlock - (log.blockNumber ?? 0n) + 1n
          : 0n;
        const code = Number(log.args.outcome ?? 0);
        return {
          runId: log.args.runId!,
          outcomeCode: code,
          outcomeLabel: outcomeMap[code] ?? "UNKNOWN",
          attackClassCode: Number(log.args.attackClass ?? 0),
          sandboxSigner: normalizeEvmAddress(log.args.sandboxSigner!),
          attestor: normalizeEvmAddress(log.args.attestor!),
          reportHash: log.args.reportHash!,
          hasVerifiedActionSig: Boolean(log.args.hasVerifiedActionSig),
          blockNumber: (log.blockNumber ?? 0n).toString(),
          confirmations: confs.toString(),
          txHash: log.transactionHash!,
          explorerTxUrl: `${explorerBase}/tx/${log.transactionHash}`,
        };
      });

    return {
      deployed: true,
      chainId: env.ELENCHI_ARENA_CHAIN_ID,
      contractAddress: contractAddr,
      minConfirmations,
      items,
      error: null,
    };
  } catch (err) {
    return {
      deployed: true,
      chainId: env.ELENCHI_ARENA_CHAIN_ID,
      contractAddress: contractAddr,
      minConfirmations,
      items: [],
      error: err instanceof Error ? err.message : "Failed to query chain logs",
    };
  }
}

export async function inspectTokenAndPonsProvenance(env: ElenchiEnv) {
  const feeCategories = [
    {
      category: "Pons Platform / Base Swap Fee",
      controlledBy: "Pons Protocol",
      status: "Determined by the chosen Pons version/pool contract at launch; Elenchi never collects or modifies swap fees.",
    },
    {
      category: "Optional Pons Creator Tax",
      controlledBy: "Pons V2 Launch Configuration (if applicable)",
      status:
        env.TOKEN_LAUNCH_STATE === "PRELAUNCH"
          ? "PRELAUNCH — owner's proposed 3% creator trading tax is a manual Pons UI launch parameter to verify against the actual Pons version before signing. Not an ERC-20 transfer tax."
          : "Verify exact deployed parameters on Blockscout and Pons token page.",
    },
    {
      category: "Temporary Opening Snipe Tax",
      controlledBy: "Pons Protocol (version-dependent)",
      status: "Applies only if enabled by the specific Pons factory version during launch block window.",
    },
    {
      category: "Elenchi Arena On-Chain Attestation Fee",
      controlledBy: "ElenchiArena.sol (optional)",
      status: "0 ETH in off-chain sandbox; optional capped Wei fee (<= 0.01 ETH) when registering on-chain attestations.",
    },
    {
      category: "Elenchi Metered AI / API Usage",
      controlledBy: "Elenchi API Service",
      status: "Free Sandbox includes rate-limited prompt-level evaluations without a wallet; heavy suites & CI adapters use cost-capped entitlements.",
    },
  ];

  if (env.TOKEN_LAUNCH_STATE === "PRELAUNCH" || !env.ELENCHI_TOKEN_ADDRESS) {
    return {
      state: "PRELAUNCH" as const,
      provenance: "NOT_LAUNCHED" as const,
      officialClaimsEnabled: false,
      chainId: env.CHAIN_ID,
      tokenAddress: null,
      launchTxHash: null,
      ponsVersion: null,
      ponsFactory: null,
      tradingUrl: null,
      explorerTokenUrl: null,
      onChainMetadata: null,
      tiers: [
        { name: "Free Sandbox", requirement: "No wallet / 0 tokens", status: "ACTIVE", capabilities: "Up to 3 adaptive rounds, all 5 synthetic attack vectors, clean benchmark check, JSON/MD export" },
        { name: "Operator (Concept: 250,000 $ELENCHI / 0.025% of 1B)", requirement: "Post-launch review", status: "COMING_SOON", capabilities: "Expanded adaptive rounds, prompt patch & retest quotas" },
        { name: "Red-Cell (Concept: 1,000,000 $ELENCHI / 0.10% of 1B)", requirement: "Post-launch review", status: "COMING_SOON", capabilities: "Multi-vector suite runs & arena attestation fee waiver" },
        { name: "Sentinel API (Concept: 5,000,000 $ELENCHI / 0.50% of 1B)", requirement: "Post-launch review", status: "COMING_SOON", capabilities: "Signed CI/CD webhook & adapter evaluations with rolling balance revalidation" },
      ],
      feeDisclosures: feeCategories,
    };
  }

  // LIVE configuration supplied — verify on-chain token & creation receipt on Robinhood Chain 4663
  const tokenAddress = normalizeEvmAddress(env.ELENCHI_TOKEN_ADDRESS);
  const client = buildRpcClient(env.RPC_URL, env.RPC_FALLBACK_URL);
  try {
    const [name, symbol, decimals, totalSupply, code] = await Promise.all([
      client.readContract({ address: tokenAddress, abi: ERC20_METADATA_ABI, functionName: "name" }),
      client.readContract({ address: tokenAddress, abi: ERC20_METADATA_ABI, functionName: "symbol" }),
      client.readContract({ address: tokenAddress, abi: ERC20_METADATA_ABI, functionName: "decimals" }),
      client.readContract({ address: tokenAddress, abi: ERC20_METADATA_ABI, functionName: "totalSupply" }),
      client.getBytecode({ address: tokenAddress }),
    ]);

    let provenance: "VERIFIED" | "UNVERIFIED" = "UNVERIFIED";
    let provenanceReason = "Launch transaction or factory address not supplied for receipt verification.";

    if (env.ELENCHI_TOKEN_LAUNCH_TX && env.ELENCHI_PONS_FACTORY && env.ELENCHI_PONS_VERSION) {
      const receipt = await client.getTransactionReceipt({ hash: env.ELENCHI_TOKEN_LAUNCH_TX });
      const expectedFactory = normalizeEvmAddress(env.ELENCHI_PONS_FACTORY).toLowerCase();
      const touchedFactory =
        receipt.to?.toLowerCase() === expectedFactory ||
        receipt.logs.some((l) => l.address.toLowerCase() === expectedFactory);
      const touchedToken = receipt.logs.some(
        (l) => l.address.toLowerCase() === tokenAddress.toLowerCase()
      );
      if (receipt.status === "success" && touchedFactory && touchedToken) {
        provenance = "VERIFIED";
        provenanceReason = `Verified creation receipt ${env.ELENCHI_TOKEN_LAUNCH_TX} touching Pons factory ${expectedFactory} and token ${tokenAddress}.`;
      } else {
        provenanceReason = "Creation receipt did not match stated Pons factory and token logs.";
      }
    }

    const officialClaimsEnabled = Boolean(code && code !== "0x" && provenance === "VERIFIED");
    const explorerBase = env.EXPLORER_URL.replace(/\/+$/, "");

    return {
      state: "LIVE" as const,
      provenance,
      provenanceReason,
      officialClaimsEnabled,
      chainId: env.CHAIN_ID,
      tokenAddress: officialClaimsEnabled ? tokenAddress : null,
      unverifiedCandidateAddress: officialClaimsEnabled ? null : tokenAddress,
      launchTxHash: env.ELENCHI_TOKEN_LAUNCH_TX,
      ponsVersion: env.ELENCHI_PONS_VERSION,
      ponsFactory: env.ELENCHI_PONS_FACTORY,
      tradingUrl: officialClaimsEnabled ? env.ELENCHI_PONS_TRADING_URL : null,
      explorerTokenUrl: officialClaimsEnabled ? `${explorerBase}/token/${tokenAddress}` : null,
      onChainMetadata: {
        name,
        symbol,
        decimals,
        totalSupplyFormatted: formatUnits(totalSupply, decimals),
      },
      tiers: [],
      feeDisclosures: feeCategories,
    };
  } catch (err) {
    return {
      state: "LIVE" as const,
      provenance: "UNVERIFIED" as const,
      provenanceReason: err instanceof Error ? err.message : "Failed to verify token on Robinhood Chain RPC",
      officialClaimsEnabled: false,
      chainId: env.CHAIN_ID,
      tokenAddress: null,
      launchTxHash: env.ELENCHI_TOKEN_LAUNCH_TX,
      ponsVersion: env.ELENCHI_PONS_VERSION,
      ponsFactory: env.ELENCHI_PONS_FACTORY,
      tradingUrl: null,
      explorerTokenUrl: null,
      onChainMetadata: null,
      tiers: [],
      feeDisclosures: feeCategories,
    };
  }
}
