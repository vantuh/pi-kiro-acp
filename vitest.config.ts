import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the unit tests; test/e2e/live.mjs is a guarded live probe.
    include: ["test/*.test.ts"],
    // Files spawn kiro-cli and bind loopback ports, so they run one at a time.
    fileParallelism: false,
    // Allow CLI startup and the abort test's 30s hang guard.
    testTimeout: 60_000,
  },
});
