import { expect, it } from "vitest";
import { createLabelMemory } from "../src/server/labels.js";
import { createApp } from "../src/server/app.js";
const human = { vv_type: "human" as const, vv_detail: "none|-|-|-|human|final" };
const verified = { vv_type: "agent_verified" as const, vv_detail: "openai|-|-|-|human|final" };
const spoofed = { vv_type: "bot_spoofed" as const, vv_detail: "none|-|-|-|human|final" };
it("inherited hits cannot extend proof; invalid evidence cannot replace active proof", () => {
  let now = 0;
  const m = createLabelMemory(10, 100, () => now);
  m.apply("s", verified, true, 50);
  now = 25;
  expect(m.apply("s", spoofed).vv_type).toBe("agent_verified");
  now = 49;
  expect(m.apply("s", human).vv_type).toBe("agent_verified");
  now = 50;
  expect(m.apply("s", human)).toEqual(human);
  m.apply("s", spoofed);
  expect(m.apply("s", verified, true, 100).vv_type).toBe("agent_verified");
});
it("IP proof has a fixed memory maximum despite inherited traffic", () => {
  let now = 0;
  const m = createLabelMemory(10, 100, () => now);
  m.apply("s", verified);
  now = 99;
  m.apply("s", human);
  now = 100;
  expect(m.apply("s", human)).toEqual(human);
});
it("health token gates verification details", async () => {
  const app = createApp({
    measurementId: "G-TEST",
    cookieSecret: "s".repeat(64),
    siteOrigin: "https://example.com",
    healthToken: "secret",
  });
  try {
    expect((await app.inject("/health")).json().agentVerification).toBeUndefined();
    expect(
      (await app.inject({ url: "/health", headers: { "x-health-token": "wrong" } })).json()
        .agentVerification,
    ).toBeUndefined();
    expect(
      (await app.inject({ url: "/health", headers: { "x-health-token": "secret" } })).json()
        .agentVerification.enabled,
    ).toBe(false);
  } finally {
    await app.close();
  }
});

it("trusts private proxy peers but ignores forwarded IP from public peers", async () => {
  const { configFromEnv } = await import("../src/server/config.js");
  const config = configFromEnv({
    GA4_MEASUREMENT_ID: "G-TEST",
    COOKIE_SECRET: "s".repeat(64),
    SITE_ORIGIN: "https://example.com",
  });
  const ips: string[] = [];
  const app = createApp(config, async (url) => {
    ips.push(new URL(String(url)).searchParams.get("_uip")!);
    return new Response(null, { status: 204 });
  });
  try {
    for (const remoteAddress of ["203.0.113.9", "172.18.0.2", "::ffff:172.18.0.2", "127.0.0.1"]) {
      await app.inject({
        method: "POST",
        url: "/d",
        remoteAddress,
        headers: { origin: config.siteOrigin, "x-forwarded-for": "198.51.100.10" },
        payload: {
          name: "page_view",
          params: {},
          consent: { analytics_storage: "denied" },
          client_id: "1.2",
          session_id: 1,
          page_id: "1",
          hit_index: 1,
        },
      });
    }
    expect(ips).toEqual(["203.0.113.9", "198.51.100.10", "198.51.100.10", "198.51.100.10"]);
    expect(
      configFromEnv({
        ...process.env,
        GA4_MEASUREMENT_ID: "G-TEST",
        COOKIE_SECRET: "s".repeat(64),
        TRUST_PROXY: "10.2.0.0/16",
        HEALTH_TOKEN: "token",
      }),
    ).toMatchObject({ trustProxy: ["10.2.0.0/16"], healthToken: "token" });
  } finally {
    await app.close();
  }
});

it("same page ID with another random ping client ID cannot inherit evidence", async () => {
  const { sendDeniedPing } = await import("../src/server/google.js");
  const { normalizeConsent } = await import("../src/shared/consent.js");
  const memory = createLabelMemory();
  const types: string[] = [];
  for (const [client_id, traffic_class] of [
    ["1.2", "automated"],
    ["3.4", "human"],
    ["1.2", "human"],
  ]) {
    await sendDeniedPing(
      { measurementId: "G-TEST" },
      {
        name: "page_view",
        params: { traffic_class },
        consent: normalizeConsent({}),
        client_id: client_id!,
        session_id: 1,
        page_id: "123",
        hit_index: 1,
      },
      undefined,
      async (url) => {
        types.push(new URL(String(url)).searchParams.get("ep.vv_type")!);
        return new Response(null, { status: 204 });
      },
      undefined,
      undefined,
      memory,
    );
  }
  expect(types).toEqual(["bot_automation", "human", "bot_automation"]);
});

it("ping churn cannot evict session evidence", async () => {
  const { createLabelMemories } = await import("../src/server/labels.js");
  const m = createLabelMemories(2);
  m.sessions.apply("session", verified);
  for (let i = 0; i < 10; i++) m.pages.apply(String(i), spoofed);
  expect(m.pages.size).toBe(2);
  expect(m.sessions.apply("session", human).vv_type).toBe("agent_verified");
});

it("first-visit parallel events and the issued cookie keep one analytics identity", async () => {
  const hits: URLSearchParams[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const config = {
    measurementId: "G-TEST",
    cookieSecret: "s".repeat(64),
    siteOrigin: "https://example.com",
  };
  const app = createApp(config, async (url) => {
    hits.push(new URL(String(url)).searchParams);
    if (hits.length === 1) await gate;
    return new Response(null, { status: 204 });
  });
  const now = Date.now();
  const post = (name: string, cookie = "") =>
    app.inject({
      method: "POST",
      url: "/e",
      headers: { origin: config.siteOrigin, cookie },
      payload: {
        event_id: crypto.randomUUID(),
        name,
        params: {},
        client_id: "123.456",
        session_id: 1,
        session_started_ms: now,
        session_expires_ms: now + 1800000,
        timestamp_ms: now,
        consent: { analytics_storage: "granted" },
      },
    });
  try {
    const first = post("page_view");
    await new Promise<void>((resolve) => {
      const check = () => (hits.length ? resolve() : setTimeout(check, 1));
      check();
    });
    const parallel = post("purchase");
    release();
    const [response, other] = await Promise.all([first, parallel]);
    expect(response.statusCode).toBe(204);
    expect(other.statusCode).toBe(204);
    await post("purchase", String(response.headers["set-cookie"]));
    expect(hits).toHaveLength(3);
    expect(new Set(hits.map((h) => h.get("cid"))).size).toBe(1);
    expect(new Set(hits.map((h) => h.get("sid"))).size).toBe(1);
    expect(hits.filter((h) => h.get("_ss") === "1")).toHaveLength(1);
    expect(hits.filter((h) => h.get("_fv") === "1")).toHaveLength(1);
  } finally {
    release();
    await app.close();
  }
});

it("staged delivery retains the signed expiry and replay cannot inherit stored proof", async () => {
  const { sendDeniedPing } = await import("../src/server/google.js");
  const { normalizeConsent } = await import("../src/shared/consent.js");
  let now = Date.now();
  const expires = now + 1000;
  const m = createLabelMemory(10, 1800000, () => now);
  const types: string[] = [];
  const ping = {
    name: "page_view",
    params: { traffic_class: "human" },
    consent: normalizeConsent({}),
    client_id: "1.2",
    session_id: 1,
    page_id: "1",
    hit_index: 1,
  };
  const proof: import("visitor-verdict-server").AgentVerdict = {
    verification: "signature_valid",
    reason: "verified",
    agent_purpose: "user_directed",
    claimed: { uaTokens: [], signatureAgents: [] },
    signatures: [],
    verified: { operator: "openai", method: "signature", expiresAt: expires / 1000 },
  };
  const send = (v?: typeof proof) =>
    sendDeniedPing(
      { measurementId: "G-TEST" },
      ping,
      undefined,
      async (url) => {
        types.push(new URL(String(url)).searchParams.get("ep.vv_type")!);
        return new Response(null, { status: 204 });
      },
      undefined,
      Promise.resolve(v),
      m,
    );
  await send(proof);
  await send({
    ...proof,
    verification: "signature_invalid",
    reason: "replay",
    verified: undefined,
  });
  now += 500;
  await send();
  now = expires;
  await send();
  expect(types).toEqual(["agent_verified", "bot_spoofed", "agent_verified", "human"]);
});
