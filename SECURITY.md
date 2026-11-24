# Security Policy & Invariants

## Scope

Elenchi is an independent, non-custodial adversarial evaluation platform for AI trading agents on Robinhood Chain (`chainId: 4663`). Security-critical surfaces in this repository include:

1. **Deterministic Policy Evaluator (`packages/policy-evaluator`)** — allowlist enforcement, EIP-55 address normalization, basis-point slippage ceiling, position size cap (`bigint` Wei), verified contract & liquidity checks, and clean-benchmark anti-gaming.
2. **Isolated EIP-712 Evidence Signer (`packages/eip712`)** — closure-scoped ephemeral key generation, single-use nonce tracking, domain binding (`name = "ElenchiArena"`, `version = "1"`, `chainId`, `verifyingContract`), and mandatory `EVIDENCE_NOTICE_HASH`.
3. **On-Chain Evidence Registry (`contracts/src/ElenchiArena.sol`)** — EIP-712 `SimulatedAction` + `AttestationPermit` recovery, EIP-2 low-S malleability rejection, nonce replay protection, deadline checks, and pause controls.
4. **Arena API & Outbound Agent Protocol (`apps/api`)** — SSRF filtering on webhook URLs, SHA-256 hashed `eat_` bearer tokens, AES-256-GCM opt-in prompt encryption, HttpOnly HMAC session cookies, and strict DOM text-only (`textContent`) trace rendering.

## Core Security Invariants

- **Zero execution or custody capability:** `ElenchiArena.sol` contains **no** token swap, router, approval, `transferFrom`, or vault custody functions. Simulated actions carry `keccak256("ELENCHI_EVIDENCE_ONLY_NON_EXECUTABLE_V1")` and can never move live funds.
- **No LLM grading:** Breach verdicts (`COMPROMISED` vs `PASSED_SUITE` vs `INCONCLUSIVE`) are computed exclusively by `@elenchi/policy-evaluator` against deterministic mandate rules, never by asking an LLM whether an attack succeeded.
- **Challenger / Defender isolation:** The Challenger (Red Agent) receives only sanitized refusal category codes and never sees the Defender's private system prompt, hidden numeric thresholds, or ephemeral signing key.
- **No silent token minting:** This repository never deploys or mints an ERC-20 token. `TOKEN_LAUNCH_STATE` remains `PRELAUNCH` until verified on-chain via `scripts/bind-pons-token.ts`.

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for exploitable vulnerabilities in `ElenchiArena.sol`, EIP-712 signature verification, or SSRF/session boundaries. Reach out via DM on [@Elenchi_dev](https://x.com/Elenchi_dev) to request a private disclosure channel.
