import { expect, it, vi } from "vitest";
import { createLabelMemory, withLabels } from "../src/server/labels.js";
import { configFromEnv } from "../src/server/config.js";
import { createApp } from "../src/server/app.js";
import type { AgentFields } from "../src/server/agent-verification.js";
const human = { vv_type: "human" as const, vv_detail: "none|-|-|-|human|final" };
const proof = { vv_type: "agent_verified" as const, vv_detail: "openai|-|-|-|human|final" };
const env = { GA4_MEASUREMENT_ID: "G-TEST", COOKIE_SECRET: "s".repeat(64) };
it("fresh proof renews equal rank and retains the current operator", () => {
  let now = 0;
  const m = createLabelMemory(10, 100, () => now);
  m.apply("s", proof, true, 50);
  now = 40;
  const current = {
    vv_type: "crawler_verified" as const,
    vv_detail: "anthropic|-|-|-|human|final",
  };
  expect(m.apply("s", current, true, 130)).toEqual(current);
  now = 60;
  expect(m.apply("s", human).vv_detail.split("|")[0]).toBe("anthropic");
  now = 130;
  expect(m.apply("s", human)).toEqual(human);
});
it.each([NaN, Infinity, -Infinity, 0])("invalid expiry %s cannot enter memory", (expiry) => {
  const m = createLabelMemory(10, 100, () => 1);
  m.apply("s", proof, true, expiry);
  expect(m.size).toBe(0);
});
it("pending churn does not evict proof and expired entries go before live entries", () => {
  let now = 0;
  const m = createLabelMemory(2, 100, () => now);
  m.apply("live", proof, true, 100);
  m.apply("expired", proof, true, 10);
  for (let i = 0; i < 10; i++)
    m.apply(String(i), { vv_type: "pending", vv_detail: "none|-|-|-|-|-" });
  now = 20;
  m.apply("new", human);
  expect(m.apply("live", human).vv_type).toBe("agent_verified");
});
it("replay among candidates sticks on unverified sessions and preserves active proof", () => {
  const m = createLabelMemory();
  const replay: AgentFields = {
    verification: "signature_invalid",
    reason: "missing_keyid",
    agent_purpose: "unknown",
    claimed: { uaTokens: [], signatureAgents: [] },
    signatures: [{ label: "s", result: "signature_invalid", reason: "replay" }],
  };
  const hit = (key: string, v?: AgentFields) =>
    withLabels({ traffic_class: "human" }, v, { memory: m, key });
  expect(hit("new", replay).vv_type).toBe("bot_spoofed");
  expect(hit("new").vv_type).toBe("bot_spoofed");
  m.apply("verified", proof);
  expect(hit("verified", replay).vv_type).toBe("bot_spoofed");
  expect(hit("verified").vv_type).toBe("agent_verified");
});
it("proxy defaults defer to app; empty explicitly disables and invalid entries fail early", () => {
  expect(configFromEnv(env).trustProxy).toBeUndefined();
  expect(configFromEnv({ ...env, TRUST_PROXY: " , " }).trustProxy).toBe(false);
  expect(configFromEnv({ ...env, TRUST_PROXY: "loopback, ::1,10.0.0.0/8" }).trustProxy).toEqual([
    "loopback",
    "::1",
    "10.0.0.0/8",
  ]);
  for (const value of ["loopback uniquelocal", "[::1]", "10.0.0.0/33"])
    expect(() => configFromEnv({ ...env, TRUST_PROXY: value })).toThrow(/TRUST_PROXY/);
});
it.each(["", " ", " secret", "secret "])("rejects unusable health token %s", (token) => {
  expect(() => configFromEnv({ ...env, HEALTH_TOKEN: token })).toThrow(/HEALTH_TOKEN/);
});
it("health responses cannot be cached across authorization", async () => {
  const app = createApp({
    measurementId: "G-TEST",
    cookieSecret: "s".repeat(64),
    siteOrigin: "https://example.com",
    healthToken: "secret",
  });
  try {
    for (const token of ["secret", "wrong", ""]) {
      const r = await app.inject({ url: "/health", headers: { "x-health-token": token } });
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(r.headers.vary).toBe("X-Health-Token");
      expect(Boolean(r.json().agentVerification)).toBe(token === "secret");
    }
  } finally {
    await app.close();
  }
});

it("cookieless bootstrap reads neither slide nor ignore the absolute deadline", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = 1800000000000;
  vi.setSystemTime(start);
  const ids: string[] = [];
  const app = createApp(
    { measurementId: "G-TEST", cookieSecret: "s".repeat(64), siteOrigin: "https://example.com" },
    async (url) => {
      ids.push(new URL(String(url)).searchParams.get("cid")!);
      return new Response(null, { status: 204 });
    },
  );
  const post = () =>
    app.inject({
      method: "POST",
      url: "/e",
      headers: { origin: "https://example.com" },
      payload: {
        event_id: crypto.randomUUID(),
        name: "purchase",
        params: {},
        client_id: "123.456",
        session_id: 1,
        session_started_ms: Date.now(),
        session_expires_ms: Date.now() + 1800000,
        timestamp_ms: Date.now(),
        consent: { analytics_storage: "granted" },
      },
    });
  try {
    expect((await post()).statusCode).toBe(204);
    vi.setSystemTime(start + 59950);
    expect((await post()).statusCode).toBe(204);
    vi.setSystemTime(start + 60001); // prune is throttled; read must enforce expiry itself.
    expect((await post()).statusCode).toBe(204);
    expect(ids).toHaveLength(3);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  } finally {
    await app.close();
    vi.useRealTimers();
  }
});
it("proof memory is capped even for a far-future expiry", () => {
  let now = 0;
  const m = createLabelMemory(10, 100, () => now);
  m.apply("s", proof, true, 10000);
  now = 100;
  expect(m.apply("s", human)).toEqual(human);
});
it("new equal-rank automation observations renew their evidence window", () => {
  let now = 0;
  const m = createLabelMemory(10, 100, () => now);
  const automation = {
    vv_type: "bot_automation" as const,
    vv_detail: "none|-|-|-|automated|final",
  };
  m.apply("s", automation);
  now = 90;
  m.apply("s", automation);
  now = 110;
  expect(m.apply("s", human).vv_type).toBe("bot_automation");
  now = 190;
  expect(m.apply("s", human)).toEqual(human);
});
