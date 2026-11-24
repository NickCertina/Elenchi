/**
 * Example 02 — Isolated EIP-712 SimulatedAction Evidence Signing & Verification
 *
 * Demonstrates Level B cryptographic intent proof on Robinhood Chain (chainId: 4663):
 * an ephemeral sandbox key signs a non-executable SimulatedAction carrying EVIDENCE_NOTICE_HASH.
 *
 * Run: npm run example:eip712
 */
import {
  EVIDENCE_NOTICE_HASH,
  EVIDENCE_NOTICE_TEXT,
  ZERO_VERIFYING_CONTRACT,
  createIsolatedSandboxSigner,
  hashTextArtifact,
  runIdToBytes32,
  verifySignedEvidenceLocally,
} from "@elenchi/eip712";

async function main() {
  const sandboxSigner = createIsolatedSandboxSigner();
  const nowSec = Math.floor(Date.now() / 1000);

  const packet = await sandboxSigner.signEvidenceOnlyAction({
    chainId: 4663,
    verifyingContract: ZERO_VERIFYING_CONTRACT,
    runId: runIdToBytes32("demo-run-001"),
    policyHash: hashTextArtifact("policy", "momentum_sniper:v1"),
    scenarioHash: hashTextArtifact("scenario", "slippage_override:v1"),
    nonce: 1n,
    deadline: nowSec + 3600,
    token: "0x000000000000000000000000000000000000c0de",
    recipient: "0x0000000000000000000000000000000000badbee",
    amountWei: 250_000_000_000_000_000n,
    maxSlippageBps: 2500,
    actionCategory: 1,
  });

  const verification = await verifySignedEvidenceLocally(packet, nowSec);

  console.log("EIP-712 SimulatedAction Evidence Packet:");
  console.log("  domain            :", `${packet.domainName} v${packet.domainVersion} (chainId ${packet.chainId})`);
  console.log("  sandboxSigner     :", packet.sandboxSigner);
  console.log("  evidenceNotice    :", EVIDENCE_NOTICE_TEXT);
  console.log("  evidenceNoticeHash:", EVIDENCE_NOTICE_HASH);
  console.log("  digest            :", packet.digest);
  console.log("  signature         :", `${packet.signature.slice(0, 34)}...${packet.signature.slice(-16)}`);
  console.log("  verifiedLocally   :", verification.valid, `(recovered ${verification.recoveredSigner})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
