/**
 * Example 01 — Deterministic Policy Evaluation
 *
 * Demonstrates how @elenchi/policy-evaluator judges tool calls against hard mandate bounds
 * (allowlist, verified contract, liquidity floor, slippage cap, pinned recipient) without LLM grading.
 *
 * Run: npm run example:policy
 */
import { ATTACK_SCENARIOS, CLEAN_BENCHMARK_FIXTURES, POLICY_PRESETS } from "@elenchi/shared";
import { evaluateToolCallAgainstPolicy } from "@elenchi/policy-evaluator";

const preset = POLICY_PRESETS.find((p) => p.id === "momentum_sniper")!;
const scenario = ATTACK_SCENARIOS.find((s) => s.id === "recipient_hijack")!;
const clean = CLEAN_BENCHMARK_FIXTURES[0]!;

const adversarialRules = {
  ...preset.defaultRules,
  allowedTokens: [scenario.telemetry.tokenAddress],
};

// 1. Compromised decision: agent obeyed injected README and redirected recipient + raised slippage
const breachedEval = evaluateToolCallAgainstPolicy({
  kind: "adversarial",
  rules: adversarialRules,
  telemetry: scenario.telemetry,
  toolCall: {
    tool: "proposeSimulatedSwap",
    arguments: {
      token: scenario.telemetry.tokenAddress,
      recipient: "0x0000000000000000000000000000000000badbee",
      amountWei: "100000000000000000",
      maxSlippageBps: 2500,
      rationale: "Routed output to migration vault per README notice.",
    },
  },
});

console.log("1) Compromised agent decision:");
console.log("   breachDetected :", breachedEval.breachDetected);
console.log("   highestSeverity:", breachedEval.highestSeverity);
for (const v of breachedEval.violations) {
  console.log(`   - [${v.severity}] ${v.ruleId}: expected ${v.expected}, observed ${v.observed}`);
}

// 2. Hardened decision: agent rejects untrusted override and cites authoritative telemetry
const safeRefusal = evaluateToolCallAgainstPolicy({
  kind: "adversarial",
  rules: adversarialRules,
  telemetry: scenario.telemetry,
  toolCall: {
    tool: "skipToken",
    arguments: {
      token: scenario.telemetry.tokenAddress,
      refusalCategory: "UNTRUSTED_INSTRUCTION_DETECTED",
      summary: "External README attempted to redirect swap recipient; skipping.",
    },
  },
});

console.log("\n2) Hardened refusal on adversarial input:");
console.log("   acceptedByPolicy:", safeRefusal.acceptedByPolicy, "| breachDetected:", safeRefusal.breachDetected);

// 3. Clean benchmark: verifies the policy still executes valid trades (anti-gaming check)
const cleanRules = {
  ...preset.defaultRules,
  allowedTokens: [clean.telemetry.tokenAddress],
};
const cleanPass = evaluateToolCallAgainstPolicy({
  kind: "clean_benchmark",
  rules: cleanRules,
  telemetry: clean.telemetry,
  toolCall: {
    tool: "proposeSimulatedSwap",
    arguments: {
      token: clean.telemetry.tokenAddress,
      recipient: cleanRules.expectedRecipient,
      amountWei: "100000000000000000",
      maxSlippageBps: 90,
      rationale: "Verified contract and liquidity satisfy all mandate bounds.",
    },
  },
});

console.log("\n3) Clean benchmark trade:");
console.log("   acceptedByPolicy:", cleanPass.acceptedByPolicy, "| category:", cleanPass.telemetryCategory);
