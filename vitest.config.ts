import { defineConfig } from "vitest/config";
// Real browser tests live in tests/e2e and run through Playwright, not here.
export default defineConfig({
  test: { include: ["tests/*.test.ts"], globalSetup: "tests/global-build.ts" },
});
