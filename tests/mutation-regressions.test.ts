import { afterEach, expect, it, vi } from "vitest";
import * as library from "visitor-verdict-server";
import { createLabelMemory } from "../src/server/labels.js";
import { configFromEnv } from "../src/server/config.js";
import { createAgentLabeller } from "../src/server/agent-verification.js";
import { createApp } from "../src/server/app.js";

vi.mock("visitor-verdict-server", async (importOriginal) => {
  const actual = await importOriginal<typeof library>();
  return { ...actual, createVerifier: vi.fn(actual.createVerifier) };
});
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
const env = {
  GA4_MEASUREMENT_ID: "G-TEST",
  COOKIE_SECRET: "s".repeat(64),
  SITE_ORIGIN: "https://example.com",
};

it("non-verified sticky evidence expires at the exact TTL boundary", () => {
  let now = 0;
  const memory = createLabelMemory(10, 100, () => now);
  const human = { vv_type: "human" as const, vv_detail: "none|-|-|-|human|final" };
  memory.apply("s", { vv_type: "bot_automation", vv_detail: "none|-|-|-|automated|final" });
  now = 99;
  expect(memory.apply("s", human).vv_type).toBe("bot_automation");
  now = 100;
  expect(memory.apply("s", human)).toEqual(human);
});

it("an explicit empty proxy list disables forwarding trust", () => {
  expect(configFromEnv({ ...env, TRUST_PROXY: "" }).trustProxy).toBe(false);
});
it("proxy entries are trimmed and empty comma fields are ignored", () => {
  expect(configFromEnv({ ...env, TRUST_PROXY: " 10.2.0.0/16 , , loopback, " }).trustProxy).toEqual([
    "10.2.0.0/16",
    "loopback",
  ]);
});
it("health tokens reject surrounding whitespace and empty values", () => {
  expect(() => configFromEnv({ ...env, HEALTH_TOKEN: " secret " })).toThrow(/HEALTH_TOKEN/);
  expect(() => configFromEnv({ ...env, HEALTH_TOKEN: "" })).toThrow(/HEALTH_TOKEN/);
});

it("the labeller replay store uses the verifier's supplied seconds clock", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let now = 1800000000;
  const labeller = createAgentLabeller("tracker.example", {
    now: () => now,
    fetcher: async () => new Response(null, { status: 404 }),
  });
  try {
    const options = vi.mocked(library.createVerifier).mock.calls.at(-1)![0];
    expect(options.maxLifetimeSeconds).toBe(7200);
    expect(options.nonceStore).toBeInstanceOf(library.MemoryNonceStore);
    const store = options.nonceStore!;
    expect(await store.insertIfAbsent("clock-check", 10)).toBe(true);
    now += 10;
    expect(await store.insertIfAbsent("clock-check", 10)).toBe(false);
    now++;
    expect(await store.insertIfAbsent("clock-check", 10)).toBe(true);
  } finally {
    labeller.close();
  }
});

it("health details remain public without a configured token even if a caller sends one", async () => {
  const app = createApp({
    measurementId: "G-TEST",
    cookieSecret: "s".repeat(64),
    siteOrigin: "https://example.com",
  });
  try {
    const response = await app.inject({
      url: "/health",
      headers: { "x-health-token": "arbitrary" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().agentVerification.enabled).toBe(false);
  } finally {
    await app.close();
  }
});
