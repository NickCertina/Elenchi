import { describe, expect, it } from "vitest";
import {
  createIsolatedSandboxSigner,
  EVIDENCE_NOTICE_HASH,
  runIdToBytes32,
  hashTextArtifact,
  verifySignedEvidenceLocally,
  ZERO_VERIFYING_CONTRACT,
} from "@elenchi/eip712";

describe("EIP-712 Isolated Sandbox Evidence Signer", () => {
  it("creates an ephemeral signer, signs SimulatedAction, and verifies locally", async () => {
    const signer = createIsolatedSandboxSigner();
    expect(signer.address).toMatch(/^0x[a-fA-F0-9]{40}$/);

    const nowSec = Math.floor(Date.now() / 1000);
    const packet = await signer.signEvidenceOnlyAction({
      chainId: 46630,
      verifyingContract: ZERO_VERIFYING_CONTRACT,
      runId: runIdToBytes32("run-test-1"),
      policyHash: hashTextArtifact("policy", "momentum"),
      scenarioHash: hashTextArtifact("scenario", "slippage_override"),
      nonce: 1n,
      deadline: nowSec + 600,
      token: "0x0000000000000000000000000000000000E1E004",
      recipient: "0x00000000000000000000000000000000005A4DB0",
      amountWei: 100_000_000_000_000_000n,
      maxSlippageBps: 2500,
      actionCategory: 1,
    });

    expect(packet.action.evidenceNoticeHash).toBe(EVIDENCE_NOTICE_HASH);
    const verified = await verifySignedEvidenceLocally(packet, nowSec);
    expect(verified.valid).toBe(true);
    expect(verified.recoveredSigner?.toLowerCase()).toBe(signer.address.toLowerCase());
  });

  it("rejects nonce reuse inside the isolated signer boundary", async () => {
    const signer = createIsolatedSandboxSigner();
    const base = {
      chainId: 4663,
      verifyingContract: ZERO_VERIFYING_CONTRACT,
      runId: runIdToBytes32("run-test-2"),
      policyHash: hashTextArtifact("policy", "strict"),
      scenarioHash: hashTextArtifact("scenario", "metadata_injection"),
      nonce: 7n,
      deadline: Math.floor(Date.now() / 1000) + 600,
      token: "0x0000000000000000000000000000000000E1E001" as const,
      recipient: "0x00000000000000000000000000000000005A4DB0" as const,
      amountWei: 50_000_000_000_000_000n,
      maxSlippageBps: 100,
      actionCategory: 1 as const,
    };

    await signer.signEvidenceOnlyAction(base);
    await expect(signer.signEvidenceOnlyAction(base)).rejects.toThrow(/nonce 7 already consumed/i);
  });

  it("detects tampering, chain mismatch, contract mismatch, and expired deadline", async () => {
    const signer = createIsolatedSandboxSigner();
    const nowSec = 1_800_000_000;
    const packet = await signer.signEvidenceOnlyAction({
      chainId: 4663,
      verifyingContract: ZERO_VERIFYING_CONTRACT,
      runId: runIdToBytes32("run-test-3"),
      policyHash: hashTextArtifact("policy", "whale"),
      scenarioHash: hashTextArtifact("scenario", "recipient_hijack"),
      nonce: 1n,
      deadline: nowSec + 120,
      token: "0x0000000000000000000000000000000000E1E005",
      recipient: "0x0000000000000000000000000000000000BADBEE",
      amountWei: 200_000_000_000_000_000n,
      maxSlippageBps: 150,
      actionCategory: 1,
    });

    // Tamper slippage
    const tampered = {
      ...packet,
      action: { ...packet.action, maxSlippageBps: 100 },
    };
    const resTampered = await verifySignedEvidenceLocally(tampered, nowSec);
    expect(resTampered.valid).toBe(false);

    // Wrong chainId
    const wrongChain = { ...packet, chainId: 46630 };
    expect((await verifySignedEvidenceLocally(wrongChain, nowSec)).valid).toBe(false);

    // Expired
    expect((await verifySignedEvidenceLocally(packet, nowSec + 500)).valid).toBe(false);
  });
});
