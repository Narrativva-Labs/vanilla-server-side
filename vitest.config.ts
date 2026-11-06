import { defineConfig } from "vitest/config";
// Real browser tests live in tests/e2e and run through Playwright, not here.
export default defineConfig({
  test: {
    include: ["tests/*.test.ts"],
    globalSetup: "tests/global-build.ts",
    // The installer tests run real shell scripts, which take longer on a busy machine.
    testTimeout: 20000,
  },
});
