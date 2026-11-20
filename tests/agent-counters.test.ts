import { afterEach, expect, it, vi } from "vitest";
import * as library from "visitor-verdict-server";
import { createApp } from "../src/server/app.js";

vi.mock("visitor-verdict-server", async (original) => ({
  ...(await original<typeof library>()),
  createVerifier: vi.fn(),
}));
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});
const config = {
  cookieSecret: "s".repeat(64),
  measurementId: "G-TEST",
  siteOrigin: "https://shop.example",
  trackerHost: "private-tracker.example",
  agentVerification: true,
};
function verdict(
  verification: library.AgentVerdict["verification"],
  reason = "test",
  crawler = false,
): library.AgentVerdict {
  return {
    verification,
    reason,
    agent_purpose: crawler ? "crawler" : "user_directed",
    claimed: { uaTokens: [], signatureAgents: [] },
    signatures: [],
    verified: { operator: "openai", method: "signature" },
  };
}
function setup() {
  let current: library.AgentVerdict | undefined;
  vi.mocked(library.createVerifier).mockReturnValue({
    verify: vi.fn(async () => {
      if (!current) throw Error("unavailable");
      return current;
    }),
    warm: vi.fn(async () => ({ ok: [], failed: [] })),
    close: vi.fn(),
    status: vi.fn(() => ({
      directories: { loaded: 0, total: 5 },
      ipLists: { loaded: 0, total: 0 },
      lastRefreshOk: null,
      lastRefreshAt: null,
    })),
  });
  const google = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const app = createApp(config, google);
  apps.push(app);
  return {
    app,
    google,
    set: (value?: library.AgentVerdict) => {
      current = value;
    },
  };
}
let sequence = 0;
function hit(route: string, browser?: string) {
  const now = Date.now();
  const common = {
    name: "page_view",
    client_id: `123.${++sequence}`,
    session_id: sequence,
    page_id: String(sequence),
    hit_index: 1,
    params: {
      page_location: "https://private-page.example/secret",
      traffic_class: browser,
      traffic_phase: "final",
    },
    consent: { analytics_storage: route === "/d" ? "denied" : "granted" },
  };
  return {
    method: "POST" as const,
    url: route,
    remoteAddress: "192.0.2.42",
    headers: {
      origin: config.siteOrigin,
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 private-ua ChatGPT-User",
      "signature-input": "private-signature",
      "signature-agent": "https://private-agent.example",
    },
    payload:
      route === "/d"
        ? common
        : {
            ...common,
            event_id: crypto.randomUUID(),
            timestamp_ms: now,
            session_started_ms: now,
            session_expires_ms: now + 1800000,
          },
  };
}
const cases = [
  ["human", "human", verdict("no_signature"), "no_signature"],
  ["pending", undefined, verdict("none"), "none"],
  ["bot_suspicious", "suspicious", verdict("none", "cache_miss"), "cache_miss/unavailable"],
  ["bot_automation", "automated", undefined, "cache_miss/unavailable"],
  [
    "agent_unverified",
    "declared_agent",
    verdict("none", "ip_evidence_unavailable"),
    "cache_miss/unavailable",
  ],
  ["agent_verified", "human", verdict("signature_valid"), "signature_valid"],
  ["crawler_verified", "human", verdict("ip_match", "match", true), "ip_match"],
  ["bot_spoofed", "human", verdict("signature_invalid"), "signature_invalid"],
] as const;
for (const route of ["/e", "/d"]) {
  it(`counts all eight final labels and verification outcomes for ${route}, without visitor data`, async () => {
    const { app, set } = setup();
    const before = (await app.inject("/health")).json().agentVerification.counters;
    for (const [, browser, evidence] of cases) {
      set(evidence);
      expect((await app.inject(hit(route, browser))).statusCode).toBe(204);
    }
    const health = (await app.inject("/health")).json();
    const counters = health.agentVerification.counters;
    expect(counters.since).toBe(before.since);
    expect(new Date(counters.since).toISOString()).toBe(counters.since);
    const counts = counters[route === "/e" ? "events" : "pings"];
    expect(counts.total).toBe(8);
    expect(Object.values(counts.byType)).toEqual(Array(8).fill(1));
    expect(counts.byVerification).toEqual({
      signature_valid: 1,
      ip_match: 1,
      signature_invalid: 1,
      no_signature: 1,
      none: 1,
      "cache_miss/unavailable": 3,
    });
    expect(counts.evidence).toEqual({ signatureHeaders: 8, uaClaim: 8, browserNonHuman: 3 });
    expect(counters[route === "/e" ? "pings" : "events"].total).toBe(0);
    const numeric = (value: unknown): void => {
      if (typeof value === "object" && value !== null) Object.values(value).forEach(numeric);
      else {
        expect(Number.isSafeInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    };
    numeric(counters.events);
    numeric(counters.pings);
    expect(JSON.stringify(health)).not.toMatch(
      /private-|192\.0\.2\.42|Mozilla|ChatGPT|secret|123\./,
    );
  });
}
it("counts sticky labels once per labelled event, ignores duplicates, rejected and filtered hits", async () => {
  const { app, set } = setup();
  set(verdict("signature_invalid"));
  const first = hit("/e", "human");
  const response = await app.inject(first);
  expect(response.statusCode).toBe(204);
  await app.inject(first);
  set(verdict("none"));
  const next = hit("/e", "human");
  next.headers = {
    ...next.headers,
    cookie: response.headers["set-cookie"] as string,
  } as typeof next.headers;
  expect((await app.inject(next)).statusCode).toBe(204);
  await app.inject({ ...hit("/e"), headers: { origin: "https://rejected.example" } });
  await app.inject({ ...hit("/e"), headers: { ...first.headers, "user-agent": "HeadlessChrome" } });
  const counts = (await app.inject("/health")).json().agentVerification.counters.events;
  expect(counts.total).toBe(2);
  expect(counts.byType.bot_spoofed).toBe(2);
  expect(counts.byVerification).toMatchObject({ signature_invalid: 1, none: 1 });
});
it("counts evidence even with verification disabled and starts new counters for a new app", async () => {
  const app = createApp(
    { ...config, agentVerification: false },
    async () => new Response(null, { status: 204 }),
  );
  apps.push(app);
  expect((await app.inject(hit("/d", "declared_agent"))).statusCode).toBe(204);
  const counts = (await app.inject("/health")).json().agentVerification.counters.pings;
  expect(counts.total).toBe(1);
  expect(counts.byType.agent_unverified).toBe(1);
  expect(counts.byVerification["cache_miss/unavailable"]).toBe(1);
  expect(counts.evidence).toEqual({ signatureHeaders: 1, uaClaim: 1, browserNonHuman: 1 });
  const second = createApp({ ...config, agentVerification: false });
  apps.push(second);
  expect((await second.inject("/health")).json().agentVerification.counters.pings.total).toBe(0);
});
it("counts each signature header independently, including empty values, and rejects UA substrings and invalid browser classes", async () => {
  const app = createApp(
    { ...config, agentVerification: false },
    async () => new Response(null, { status: 204 }),
  );
  apps.push(app);
  for (const name of ["signature", "signature-input", "signature-agent"]) {
    const request = hit("/d", "none");
    expect(
      (
        await app.inject({
          ...request,
          headers: {
            origin: config.siteOrigin,
            "content-type": "application/json",
            "user-agent": "Mozilla/5.0 FakeChatGPT-UserSuffix",
            [name]: "",
          },
        })
      ).statusCode,
    ).toBe(204);
  }
  const counts = (await app.inject("/health")).json().agentVerification.counters.pings;
  expect(counts.total).toBe(3);
  expect(counts.byType.pending).toBe(3);
  expect(counts.evidence).toEqual({ signatureHeaders: 3, uaClaim: 0, browserNonHuman: 0 });
});
