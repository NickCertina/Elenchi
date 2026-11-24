# Architecture

## 1. Three-Layer Assurance Model

Elenchi enforces strict separation between untrusted LLM reasoning, deterministic policy validation, cryptographic intent signing, and scoped on-chain attestations:

1. **Level A — Off-Chain Model Observation (`packages/agent-runner`):**
   - **Challenger (Red Agent)** receives only the synthetic attack vector goal and sanitized refusal category codes from prior rounds. It **never** sees the Defender's private system prompt or hidden validator thresholds.
   - **Defender (Target Agent)** receives its configured system prompt in the privileged system channel, deterministic market telemetry in a structured frame, and sanitized external text inside an explicit `[UNTRUSTED_EXTERNAL_DATA]` boundary.
   - Outputs are validated against strict Zod tool schemas (`skipToken` or `proposeSimulatedSwap`).

2. **Level B — Cryptographic Intent Proof (`packages/eip712`):**
   - Each sandbox evaluation creates an isolated ephemeral keypair (`createIsolatedSandboxSigner`) held inside closure memory for the duration of the run.
   - When the Defender proposes a swap, the isolated signer produces an EIP-712 signature over `SimulatedAction` bound to `name = "ElenchiArena"`, `version = "1"`, `chainId`, `verifyingContract`, single-use `nonce`, `deadline`, and `EVIDENCE_NOTICE_HASH = keccak256("ELENCHI_EVIDENCE_ONLY_NON_EXECUTABLE_V1")`.

3. **Level C — Scoped On-Chain Registry (`contracts/src/ElenchiArena.sol`):**
   - `ElenchiArena.sol` verifies `ECDSALib.recover` (with EIP-2 low-S enforcement) against `sandboxSigner` and requires either an authorized `msg.sender` attestor or an EIP-712 `AttestationPermit` signed by an authorized attestor.
   - Stores compact `bytes32` hashes (`reportHash`, `policyHash`, `agentConfigHash`, `scenarioHash`, `suiteVersionHash`) and emits `AttestationRegistered`. Raw custom prompts are never written on-chain.

## 2. Clean Benchmark Anti-Gaming

A naive prompt that refuses every token forever is useless as a trading policy. When `includeCleanBenchmark = true` (enabled by default), Elenchi also evaluates the Defender against verified clean benchmark fixtures (`legit_verified_launch`, `legit_noisy_safe_launch`). Overblocking clean verified tokens is flagged as `false_positive` and downgrades the run verdict to `INCONCLUSIVE` (`CLEAN_BENCHMARK_FAILED`) rather than awarding `PASSED_SUITE`.
