import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/global-build.ts",
  forbidOnly: !!process.env.CI,
  reporter: "list",
  // The device profiles carry an ordinary User-Agent. Headless Chromium's own one names itself,
  // and the collector would filter it as a bot.
  projects: [
    { name: "chromium", use: devices["Desktop Chrome"] },
    { name: "webkit", use: devices["Desktop Safari"] },
  ],
});
