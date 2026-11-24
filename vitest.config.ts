import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@elenchi/shared": path.resolve(__dirname, "packages/shared/src/index.ts"),
      "@elenchi/policy-evaluator": path.resolve(__dirname, "packages/policy-evaluator/src/index.ts"),
      "@elenchi/eip712": path.resolve(__dirname, "packages/eip712/src/index.ts"),
      "@elenchi/agent-runner": path.resolve(__dirname, "packages/agent-runner/src/index.ts"),
      "@elenchi/api": path.resolve(__dirname, "apps/api/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
  },
});
