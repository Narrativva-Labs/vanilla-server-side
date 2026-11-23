import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as library from "visitor-verdict-server";
import { createVerdictEcho } from "../src/client/server-verdict.js";
import { verdictEcho, withLabels } from "../src/server/labels.js";
import { createApp } from "../src/server/app.js";

vi.mock("visitor-verdict-server", async (original) => ({
  ...(await original<typeof library>()),
  createVerifier: vi.fn(),
}));
const key = "vanilla.verdict.v1";
const direct = {
  v: 1,
  ttl: 1,
  type: "agent_verified",
  operator: "openai",
  verification: "signature_valid",
  purpose: "user_directed",
};
const weak = [
  {
    ...direct,
    ttl: 1800,
    type: "automation_verified",
    operator: "browserbase",
    purpose: "intermediary",
  },
  {
    ...direct,
    ttl: 1800,
    type: "agent_verified",
    operator: "browserbase",
    purpose: "intermediary",
  },
  { ...direct, ttl: 1800, type: "crawler_verified", operator: "google", purpose: "crawler" },
];
function host() {
  const values = new Map<string, string>();
  return {
    dataLayer: [] as Record<string, unknown>[],
    values,
    sessionStorage: {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: vi.fn((k: string, v: string) => {
        values.set(k, v);
      }),
      removeItem: (k: string) => {
        values.delete(k);
      },
    },
  };
}
const proof = (purpose: library.AgentVerdict["agent_purpose"]): library.AgentVerdict => ({
  verification: "signature_valid",
  agent_purpose: purpose,
  verified: {
    operator: purpose === "intermediary" ? "browserbase" : "openai",
    method: "signature",
    expiresAt: 1800000060,
  },
  claimed: { uaTokens: [], signatureAgents: ["https://test.example"] },
  signatures: [],
  reason: "verified",
});
it("keeps v1 infrastructure compatible with the actual 0.2.0 reader and current reader", async () => {
  const p = proof("intermediary");
  expect(withLabels({}, p).vv_type).toBe("automation_verified");
  const vv = verdictEcho(p, 1800000000)!;
  expect(vv).toMatchObject({
    v: 1,
    type: "agent_verified",
    purpose: "intermediary",
    operator: "browserbase",
  });
  const source = readFileSync(new URL("./fixtures/echo-020.js", import.meta.url), "utf8");
  const oldReader = runInNewContext(source + "\nLegacyEcho020.createVerdictEcho;", {
    TextDecoder,
    setTimeout,
    clearTimeout,
  }) as typeof createVerdictEcho;
  const probe = host();
  await oldReader(probe, () => 1000)(Response.json({ vv: { ...vv, type: "automation_verified" } }));
  expect(probe.dataLayer).toHaveLength(0);
  for (const reader of [oldReader, createVerdictEcho]) {
    const h = host();
    const receive = reader(h, () => 1000);
    receive.consent(true);
    await receive(Response.json({ vv }), true);
    expect(h.dataLayer).toMatchObject([
      {
        traffic_class: "declared_agent",
        traffic_agent: "browserbase",
        traffic_agent_claim: "server_intermediary",
      },
    ]);
    expect(JSON.parse(h.values.get(key)!).vv).toMatchObject(vv);
  }
});
for (const candidate of weak)
  for (const restored of [false, true])
    for (const persist of [false, true])
      it(`${candidate.type}/${candidate.purpose} cannot replace ${restored ? "restored" : "fresh"} direct identity; persist=${persist}`, async () => {
        let now = 1000;
        const h = host();
        if (restored) h.values.set(key, JSON.stringify({ at: 1000, vv: direct }));
        const receive = createVerdictEcho(h, () => now);
        receive.consent(true);
        if (!restored) await receive(Response.json({ vv: direct }), true);
        const saved = h.values.get(key);
        const writes = h.sessionStorage.setItem.mock.calls.length;
        now = 1999;
        await receive(Response.json({ vv: candidate }), persist);
        expect(h.values.get(key)).toBe(saved);
        expect(h.sessionStorage.setItem).toHaveBeenCalledTimes(writes);
        expect(h.dataLayer).toHaveLength(1);
        expect(
          (h as unknown as { __visitorVerdictServer: unknown }).__visitorVerdictServer,
        ).toMatchObject(direct);
        now = 2000;
        await receive(Response.json({ vv: candidate }), true);
        expect(JSON.parse(h.values.get(key)!).vv).toMatchObject(candidate);
        expect(h.dataLayer).toHaveLength(candidate.type === "crawler_verified" ? 1 : 2);
      });
it("a slow infrastructure response cannot overwrite a direct identity received while decoding", async () => {
  const h = host();
  const receive = createVerdictEcho(h, () => 1000);
  receive.consent(true);
  let finish!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(JSON.stringify({ vv: weak[0] })));
      finish = () => c.close();
    },
  });
  const pending = receive(
    new Response(body, { headers: { "content-type": "application/json" } }),
    true,
  );
  await receive(Response.json({ vv: direct }), true);
  finish();
  await pending;
  expect(JSON.parse(h.values.get(key)!).vv).toMatchObject(direct);
  expect(h.dataLayer).toHaveLength(1);
});
it("withdrawal clears the direct-priority guard along with persistence", async () => {
  const h = host();
  const receive = createVerdictEcho(h, () => 1000);
  receive.consent(true);
  await receive(Response.json({ vv: direct }), true);
  receive.consent(false, true);
  receive.consent(true);
  await receive(Response.json({ vv: weak[1] }), true);
  expect(JSON.parse(h.values.get(key)!).vv).toMatchObject(weak[1]!);
});
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  vi.restoreAllMocks();
});
for (const route of ["/d", "/e"])
  for (const purpose of ["intermediary", "user_directed"] as const)
    it(`botsLabelled excludes verified ${purpose} on ${route}, including obvious bot UA`, async () => {
      vi.mocked(library.createVerifier).mockReturnValue({
        verify: vi.fn(async () => proof(purpose)),
        warm: vi.fn(async () => ({ ok: [], failed: [] })),
        close: vi.fn(),
        status: vi.fn(() => ({
          directories: { loaded: 0, total: 9 },
          ipLists: { loaded: 0, total: 0 },
          lastRefreshOk: null,
          lastRefreshAt: null,
        })),
      });
      const fields: URLSearchParams[] = [];
      const app = createApp(
        {
          measurementId: "G-TEST",
          siteOrigin: "https://shop.example",
          cookieSecret: "s".repeat(64),
          agentVerification: true,
          trackerHost: "tracker.example",
        },
        async (url, init) => {
          fields.push(new URLSearchParams(new URL(String(url)).search + "&" + (init?.body ?? "")));
          return new Response(null, { status: 204 });
        },
      );
      apps.push(app);
      const now = Date.now();
      const payload = {
        name: "page_view",
        client_id: "1.2",
        session_id: 1,
        page_id: "1",
        hit_index: 1,
        consent: { analytics_storage: route === "/d" ? "denied" : "granted" },
        params: {},
        ...(route === "/e"
          ? {
              event_id: crypto.randomUUID(),
              timestamp_ms: now,
              session_started_ms: now,
              session_expires_ms: now + 1800000,
            }
          : {}),
      };
      expect(
        (
          await app.inject({
            method: "POST",
            url: route,
            headers: { origin: "https://shop.example", "user-agent": "HeadlessChrome" },
            payload,
          })
        ).statusCode,
      ).toBe(200);
      const type = purpose === "intermediary" ? "automation_verified" : "agent_verified";
      expect(fields[0]!.get("ep.vv_type")).toBe(type);
      const health = (await app.inject("/health")).json();
      expect(health.google.botsLabelled).toBe(0);
      expect(
        health.agentVerification.counters[route === "/d" ? "pings" : "events"].byType[type],
      ).toBe(1);
    });
for (const route of ["/d", "/e"])
  for (const name of ["page_view", "traffic_class"])
    it(`${route} ${name} keeps dom_host evidence with claim param only on updates`, async () => {
      const fields: URLSearchParams[] = [];
      const app = createApp(
        {
          measurementId: "G-TEST",
          siteOrigin: "https://shop.example",
          cookieSecret: "s".repeat(64),
        },
        async (url, init) => {
          fields.push(new URLSearchParams(new URL(String(url)).search + "&" + (init?.body ?? "")));
          return new Response(null, { status: 204 });
        },
      );
      apps.push(app);
      const now = Date.now();
      const payload = {
        name,
        client_id: "1.2",
        session_id: 1,
        page_id: "1",
        hit_index: 1,
        consent: { analytics_storage: route === "/d" ? "denied" : "granted" },
        params: {
          traffic_class: "declared_agent",
          traffic_phase: "agent",
          traffic_agent: "openai",
          traffic_agent_claim: "dom_host",
        },
        ...(route === "/e"
          ? {
              event_id: crypto.randomUUID(),
              timestamp_ms: now,
              session_started_ms: now,
              session_expires_ms: now + 1800000,
            }
          : {}),
      };
      expect(
        (
          await app.inject({
            method: "POST",
            url: route,
            headers: { origin: "https://shop.example" },
            payload,
          })
        ).statusCode,
      ).toBe(204);
      expect(fields[0]!.get("ep.vv_detail")?.split("|")[3]).toBe("dom_host");
      expect(fields[0]!.get("ep.traffic_agent_claim")).toBe(
        name === "traffic_class" ? "dom_host" : null,
      );
    });
