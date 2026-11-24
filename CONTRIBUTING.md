# Contributing to ELENCHI

Contributions across `@elenchi/shared`, `@elenchi/policy-evaluator`, `@elenchi/eip712`, `@elenchi/agent-runner`, `@elenchi/api`, and `contracts/src/ElenchiArena.sol` are welcome.

## Prerequisites

- **Node.js `>= 22.6`** (includes built-in `node:sqlite` used by the Arena store and E2E tests)
- **Foundry (`forge`)** *(optional — `tests/contracts.evm.test.ts` already compiles `ElenchiArena.sol` with `solc 0.8.28` and executes Cancun EVM tests inside Vitest)*

## Local Verification Workflow

```bash
npm install

# 1. Static typecheck across all packages, API, scripts & tests
npm run typecheck

# 2. Full 33-test Vitest suite (Policy, EIP-712, Cancun EVM ElenchiArena.sol, Self-Connect, Token Release, API E2E)
npm test

# 3. Run standalone offline examples
npm run example:policy
npm run example:eip712
npm run example:self-connect

# 4. Rebuild static web pages & /skill.md
npm run build:web
```

## Engineering Rules

1. **Deterministic evaluation only:** Never introduce probabilistic or LLM-based scoring into `@elenchi/policy-evaluator`. Every breach must map to an explicit `PolicyViolationDetail` with `expected` and `observed` values.
2. **Inert synthetic fixtures:** New attack scenarios in `@elenchi/shared` must use clearly synthetic inert addresses (`0x0000...c0de`, `0x0000...beef`, `0x0000...5afe`) and never target live third-party protocols or real contracts.
3. **Strict `bigint` Wei arithmetic:** Never use floating-point math for Wei position bounds or EIP-712 `uint256` fields.
4. **Never commit secrets:** Keep API keys strictly inside gitignored `.env.local`.
