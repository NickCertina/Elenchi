import {
  encodeAbiParameters,
  getAddress,
  hashTypedData,
  keccak256,
  parseAbiParameters,
  recoverTypedDataAddress,
  stringToHex,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { SignedEvidencePacket } from "@elenchi/shared";

export function normalizeEvmAddress(addr: string): `0x${string}` {
  return getAddress(addr.trim().toLowerCase());
}

export const ELENCHI_DOMAIN_NAME = "ElenchiArena" as const;
export const ELENCHI_DOMAIN_VERSION = "1" as const;
export const EVIDENCE_NOTICE_TEXT = "ELENCHI_EVIDENCE_ONLY_NON_EXECUTABLE_V1" as const;
export const EVIDENCE_NOTICE_HASH = keccak256(stringToHex(EVIDENCE_NOTICE_TEXT));

export const ZERO_VERIFYING_CONTRACT =
  "0x000000000000000000000000000000000000e1e7" as const;

export const SIMULATED_ACTION_TYPES = {
  SimulatedAction: [
    { name: "runId", type: "bytes32" },
    { name: "policyHash", type: "bytes32" },
    { name: "scenarioHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
    { name: "token", type: "address" },
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "maxSlippageBps", type: "uint16" },
    { name: "actionCategory", type: "uint8" },
    { name: "evidenceNoticeHash", type: "bytes32" },
  ],
} as const;

export const ATTESTATION_PERMIT_TYPES = {
  AttestationPermit: [
    { name: "runId", type: "bytes32" },
    { name: "reportHash", type: "bytes32" },
    { name: "policyHash", type: "bytes32" },
    { name: "agentConfigHash", type: "bytes32" },
    { name: "scenarioHash", type: "bytes32" },
    { name: "suiteVersionHash", type: "bytes32" },
    { name: "sandboxSigner", type: "address" },
    { name: "outcome", type: "uint8" },
    { name: "attackClass", type: "uint8" },
    { name: "failureKind", type: "uint8" },
    { name: "riskSeverity", type: "uint8" },
    { name: "roundsAttempted", type: "uint16" },
    { name: "roundsPassed", type: "uint16" },
    { name: "requiresActionSig", type: "bool" },
    { name: "actionStructHash", type: "bytes32" },
    { name: "attestorNonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export const SIMULATED_ACTION_TYPEHASH = keccak256(
  stringToHex(
    "SimulatedAction(bytes32 runId,bytes32 policyHash,bytes32 scenarioHash,uint256 nonce,uint64 deadline,address token,address recipient,uint256 amount,uint16 maxSlippageBps,uint8 actionCategory,bytes32 evidenceNoticeHash)"
  )
);

export interface SimulatedActionMessage {
  runId: `0x${string}`;
  policyHash: `0x${string}`;
  scenarioHash: `0x${string}`;
  nonce: bigint;
  deadline: bigint;
  token: `0x${string}`;
  recipient: `0x${string}`;
  amount: bigint;
  maxSlippageBps: number;
  actionCategory: 0 | 1;
  evidenceNoticeHash: `0x${string}`;
}

export interface AttestationPermitMessage {
  runId: `0x${string}`;
  reportHash: `0x${string}`;
  policyHash: `0x${string}`;
  agentConfigHash: `0x${string}`;
  scenarioHash: `0x${string}`;
  suiteVersionHash: `0x${string}`;
  sandboxSigner: `0x${string}`;
  outcome: number;
  attackClass: number;
  failureKind: number;
  riskSeverity: number;
  roundsAttempted: number;
  roundsPassed: number;
  requiresActionSig: boolean;
  actionStructHash: `0x${string}`;
  attestorNonce: bigint;
  deadline: bigint;
}

export function buildElenchiDomain(chainId: number, verifyingContract: `0x${string}`) {
  return {
    name: ELENCHI_DOMAIN_NAME,
    version: ELENCHI_DOMAIN_VERSION,
    chainId: BigInt(chainId),
    verifyingContract: normalizeEvmAddress(verifyingContract),
  } as const;
}

export function computeSimulatedActionStructHash(msg: SimulatedActionMessage): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        "bytes32, bytes32, bytes32, bytes32, uint256, uint64, address, address, uint256, uint16, uint8, bytes32"
      ),
      [
        SIMULATED_ACTION_TYPEHASH,
        msg.runId,
        msg.policyHash,
        msg.scenarioHash,
        msg.nonce,
        msg.deadline,
        normalizeEvmAddress(msg.token),
        normalizeEvmAddress(msg.recipient),
        msg.amount,
        msg.maxSlippageBps,
        msg.actionCategory,
        msg.evidenceNoticeHash,
      ]
    )
  );
}

export function runIdToBytes32(runUuid: string): `0x${string}` {
  return keccak256(stringToHex(`elenchi-run:${runUuid}`));
}

export function hashCanonicalJson(value: unknown): `0x${string}` {
  const canonical = JSON.stringify(value, Object.keys(value as object).sort());
  return keccak256(stringToHex(canonical));
}

export function hashTextArtifact(prefix: string, content: string): `0x${string}` {
  return keccak256(stringToHex(`${prefix}:${content}`));
}

/**
 * Isolated Sandbox Signer Boundary.
 * - Ephemeral key lives strictly inside closure memory for the duration of a single sandbox run.
 * - Never exposed to Red Agent or Target Agent prompts, logs, or API responses.
 * - Can ONLY sign the non-executable `SimulatedAction` typed struct carrying `EVIDENCE_NOTICE_HASH`.
 */
export interface IsolatedSandboxSigner {
  readonly address: `0x${string}`;
  signEvidenceOnlyAction(params: {
    chainId: number;
    verifyingContract: `0x${string}`;
    runId: `0x${string}`;
    policyHash: `0x${string}`;
    scenarioHash: `0x${string}`;
    nonce: bigint;
    deadline: number;
    token: `0x${string}`;
    recipient: `0x${string}`;
    amountWei: bigint;
    maxSlippageBps: number;
    actionCategory: 0 | 1;
  }): Promise<SignedEvidencePacket>;
}

export function createIsolatedSandboxSigner(): IsolatedSandboxSigner {
  const ephemeralPrivateKey = generatePrivateKey();
  const account = privateKeyToAccount(ephemeralPrivateKey);
  const usedNonces = new Set<string>();

  return {
    address: account.address,
    async signEvidenceOnlyAction(params) {
      const nonceKey = params.nonce.toString();
      if (usedNonces.has(nonceKey)) {
        throw new Error(`Sandbox signer nonce ${nonceKey} already consumed`);
      }
      if (params.maxSlippageBps < 0 || params.maxSlippageBps > 10_000) {
        throw new Error(`Invalid maxSlippageBps: ${params.maxSlippageBps}`);
      }
      usedNonces.add(nonceKey);

      const normalizedToken = normalizeEvmAddress(params.token);
      const normalizedRecipient = normalizeEvmAddress(params.recipient);
      const normalizedContract = normalizeEvmAddress(params.verifyingContract);

      const message: SimulatedActionMessage = {
        runId: params.runId,
        policyHash: params.policyHash,
        scenarioHash: params.scenarioHash,
        nonce: params.nonce,
        deadline: BigInt(params.deadline),
        token: normalizedToken,
        recipient: normalizedRecipient,
        amount: params.amountWei,
        maxSlippageBps: params.maxSlippageBps,
        actionCategory: params.actionCategory,
        evidenceNoticeHash: EVIDENCE_NOTICE_HASH,
      };

      const domain = buildElenchiDomain(params.chainId, normalizedContract);
      const structHash = computeSimulatedActionStructHash(message);
      const digest = hashTypedData({
        domain,
        types: SIMULATED_ACTION_TYPES,
        primaryType: "SimulatedAction",
        message,
      });
      const signature = await account.signTypedData({
        domain,
        types: SIMULATED_ACTION_TYPES,
        primaryType: "SimulatedAction",
        message,
      });

      return {
        chainId: params.chainId,
        verifyingContract: normalizedContract,
        domainName: ELENCHI_DOMAIN_NAME,
        domainVersion: ELENCHI_DOMAIN_VERSION,
        sandboxSigner: account.address,
        action: {
          runId: params.runId,
          policyHash: params.policyHash,
          scenarioHash: params.scenarioHash,
          nonce: params.nonce.toString(),
          deadline: params.deadline,
          token: normalizedToken,
          recipient: normalizedRecipient,
          amount: params.amountWei.toString(),
          maxSlippageBps: params.maxSlippageBps,
          actionCategory: params.actionCategory,
          evidenceNoticeHash: EVIDENCE_NOTICE_HASH,
        },
        structHash,
        digest,
        signature,
        trustDisclosure:
          "EIP-712 cryptographic intent proof (Level B): proves this ephemeral sandbox key signed this non-executable SimulatedAction packet under the specified chainId and contract domain. Does NOT independently prove off-chain LLM reasoning or live third-party bot identity.",
      };
    },
  };
}

export async function verifySignedEvidenceLocally(
  packet: SignedEvidencePacket,
  expectedNowSec?: number
): Promise<{ valid: boolean; recoveredSigner: `0x${string}` | null; reason?: string }> {
  try {
    if (packet.action.evidenceNoticeHash !== EVIDENCE_NOTICE_HASH) {
      return { valid: false, recoveredSigner: null, reason: "Invalid evidenceNoticeHash" };
    }
    if (expectedNowSec !== undefined && packet.action.deadline < expectedNowSec) {
      return { valid: false, recoveredSigner: null, reason: "Signature expired" };
    }
    const message: SimulatedActionMessage = {
      runId: packet.action.runId,
      policyHash: packet.action.policyHash,
      scenarioHash: packet.action.scenarioHash,
      nonce: BigInt(packet.action.nonce),
      deadline: BigInt(packet.action.deadline),
      token: normalizeEvmAddress(packet.action.token),
      recipient: normalizeEvmAddress(packet.action.recipient),
      amount: BigInt(packet.action.amount),
      maxSlippageBps: packet.action.maxSlippageBps,
      actionCategory: packet.action.actionCategory,
      evidenceNoticeHash: packet.action.evidenceNoticeHash,
    };
    const domain = buildElenchiDomain(packet.chainId, packet.verifyingContract);
    const recovered = await recoverTypedDataAddress({
      domain,
      types: SIMULATED_ACTION_TYPES,
      primaryType: "SimulatedAction",
      message,
      signature: packet.signature,
    });
    if (recovered.toLowerCase() !== packet.sandboxSigner.toLowerCase()) {
      return {
        valid: false,
        recoveredSigner: recovered,
        reason: `Recovered ${recovered} != expected ${packet.sandboxSigner}`,
      };
    }
    return { valid: true, recoveredSigner: recovered };
  } catch (err) {
    return {
      valid: false,
      recoveredSigner: null,
      reason: err instanceof Error ? err.message : "Verification failed",
    };
  }
}

export async function signAttestationPermit(params: {
  attestorPrivateKey: `0x${string}`;
  chainId: number;
  verifyingContract: `0x${string}`;
  permit: AttestationPermitMessage;
}): Promise<`0x${string}`> {
  const account = privateKeyToAccount(params.attestorPrivateKey);
  const domain = buildElenchiDomain(params.chainId, params.verifyingContract);
  return account.signTypedData({
    domain,
    types: ATTESTATION_PERMIT_TYPES,
    primaryType: "AttestationPermit",
    message: {
      ...params.permit,
      sandboxSigner: normalizeEvmAddress(params.permit.sandboxSigner),
    },
  });
}

export { toHex };
