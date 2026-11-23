import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { createTracker } from "../src/client/tracker.js";
import { deniedParams } from "../src/shared/denied-params.js";
import { configFromEnv } from "../src/server/config.js";
import { collectRequest } from "../src/server/google.js";
import { retryFingerprint } from "../src/server/retry-fingerprint.js";
import { consentSnapshot } from "../src/shared/consent.js";
import { page } from "./browser-fixture.js";
const config = {
  siteOrigin: "https://shop.example",
  measurementId: "G-TEST",
  cookieSecret: "s".repeat(64),
};
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  vi.useRealTimers();
});
const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
const event = () => ({
  name: "purchase",
  event_id: crypto.randomUUID(),
  client_id: "1.2",
  session_id: 1,
  session_started_ms: Date.now(),
  session_expires_ms: Date.now() + 1800000,
  timestamp_ms: Date.now(),
  consent: { analytics_storage: "granted" },
  params: {} as Record<string, unknown>,
});
const ping = () => ({
  name: "purchase",
  client_id: "1.2",
  session_id: 1,
  page_id: "1",
  hit_index: 1,
  consent: { analytics_storage: "denied" },
  params: {} as Record<string, unknown>,
});
function appSetup(extra: Partial<Parameters<typeof createApp>[0]> = {}) {
  const google = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const app = createApp({ ...config, ...extra }, google);
  apps.push(app);
  const post = (route: string, params: Record<string, unknown>, name = "purchase") =>
    app.inject({
      method: "POST",
      url: route,
      headers: { origin: config.siteOrigin },
      payload: { ...(route === "/d" ? ping() : event()), name, params },
    });
  const fields = () => {
    const [url, init] = google.mock.calls.at(-1)!;
    return new URLSearchParams(new URL(String(url)).search + "&" + (init?.body ?? ""));
  };
  return { app, google, post, fields };
}
for (const value of ["a@b.cz", "12", Infinity, NaN, null, {}, true])
  it(`rejects denied value ${String(value)}`, () => {
    expect(deniedParams({ value })).not.toHaveProperty("value");
  });
for (const currency of ["a@b.cz", "czk", "EURO", "12", null, {}])
  it(`rejects denied currency ${String(currency)}`, () => {
    expect(deniedParams({ currency })).not.toHaveProperty("currency");
  });
it("keeps finite money and uppercase currency, strips browser vv fields", () => {
  expect(
    deniedParams({ value: -12.5, currency: "CZK", vv_type: "human", vv_detail: "email@test" }),
  ).toEqual({ value: -12.5, currency: "CZK" });
});
for (const route of ["/d", "/e"]) {
  it(`strips ordinary browser claims on ${route}`, async () => {
    const { post, fields } = appSetup();
    await post(route, { traffic_agent_claim: "dom_host" });
    expect(fields().has("ep.traffic_agent_claim")).toBe(false);
  });
  for (const claim of ["server_signature", "server_ip", "server_intermediary"])
    it(`rejects browser ${claim} on ${route}`, async () => {
      const { post, fields } = appSetup();
      await post(
        route,
        {
          traffic_class: "declared_agent",
          traffic_phase: "agent",
          traffic_agent: "openai",
          traffic_agent_claim: claim,
        },
        "traffic_class",
      );
      expect(fields().has("ep.traffic_agent_claim")).toBe(false);
    });
}
it("does not export invalid money or currency in direct denied requests", async () => {
  const { post, fields } = appSetup();
  await post("/d", { value: "a@b.cz", currency: "a@b.cz" });
  expect(fields().has("ep.value")).toBe(false);
  expect(fields().has("cu")).toBe(false);
});
it("does not export browser vv values or invalid money on the browser /d wire", () => {
  const p = page([["consent", "update", { analytics_storage: "denied" }]]);
  p.command("event", "purchase", {
    value: "a@b.cz",
    currency: "a@b.cz",
    vv_type: "fake",
    vv_detail: "email@test",
  });
  const params = JSON.parse(String(p.fetcher.mock.calls.at(-1)![1]?.body)).params;
  for (const key of ["value", "currency", "vv_type", "vv_detail"])
    expect(params).not.toHaveProperty(key);
});
it("legacy obvious-bot filtering also covers denied pings", async () => {
  const { app, google } = appSetup({ filterObviousBots: true });
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/d",
        headers: { origin: config.siteOrigin, "user-agent": "HeadlessChrome" },
        payload: ping(),
      })
    ).statusCode,
  ).toBe(204);
  expect(google).not.toHaveBeenCalled();
  expect((await app.inject("/health")).json().google).toMatchObject({
    botsFiltered: 1,
    botsLabelled: 0,
  });
});
it("does not count obvious UAs for discarded engagement or withdrawn hits", async () => {
  const { app, google } = appSetup();
  const headers = { origin: config.siteOrigin, "user-agent": "HeadlessChrome" };
  await app.inject({
    method: "POST",
    url: "/e",
    headers,
    payload: { ...event(), name: "page_engagement" },
  });
  await app.inject({ method: "POST", url: "/p", headers, payload: { client_id: "1.2" } });
  await app.inject({ method: "POST", url: "/e", headers, payload: event() });
  expect(google).not.toHaveBeenCalled();
  expect((await app.inject("/health")).json().google.botsLabelled).toBe(0);
});
for (const mode of ["hidden", "SPA"] as const)
  for (const status of [429, 503])
    it(`preserves retry and verdict when ${mode} returns ${status}`, async () => {
      let now = Date.now();
      let finish!: (r: Response) => void;
      const verdict = vi.fn(async () => {});
      let purchases = 0;
      const fetcher = vi.fn<typeof fetch>((_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.name === "page_view")
          return new Promise((r) => {
            finish = r;
          });
        return Promise.resolve(
          new Response(null, {
            status: body.name === "purchase" && ++purchases === 1 ? status : 204,
          }),
        );
      });
      const t = createTracker(
        "https://tracker.example/e",
        {
          href: () => config.siteOrigin,
          referrer: () => "",
          now: () => now,
          uuid: () => crypto.randomUUID(),
          warn: vi.fn(),
          fetch: fetcher,
          verdict,
        },
        new Set(["purchase"]),
      );
      t.update({ analytics_storage: "granted" });
      t.track("purchase", { transaction_id: "one" });
      if (mode === "SPA") t.leave(config.siteOrigin);
      else t.exit(0);
      await settle();
      finish(new Response(null, { status: 204 }));
      await settle();
      now += 1100;
      await t.flush();
      await settle();
      const hits = fetcher.mock.calls.map(([, i]) => JSON.parse(String(i?.body)));
      expect(hits.filter((h) => h.name === "purchase")).toHaveLength(2);
      expect(t.pending()).toBe(0);
      expect(verdict).toHaveBeenCalledTimes(3);
    });
it("exit resolves mature consent waiting without a readiness hold", async () => {
  let now = Date.now();
  const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
  const t = createTracker(
    "https://tracker.example/e",
    {
      href: () => config.siteOrigin,
      referrer: () => "",
      now: () => now,
      uuid: () => crypto.randomUUID(),
      warn: vi.fn(),
      fetch: fetcher,
    },
    new Set(["purchase"]),
  );
  t.update({ analytics_storage: "granted" }, 500);
  t.track("purchase");
  expect(fetcher).not.toHaveBeenCalled();
  now += 600;
  t.exit(0);
  expect(fetcher.mock.calls.map(([, i]) => JSON.parse(String(i?.body)).name)).toEqual([
    "page_view",
    "purchase",
  ]);
});
it("a page view dispatched on exit suppresses denied pings after withdrawal", async () => {
  let now = Date.now();
  const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
  const t = createTracker(
    "https://tracker.example/e",
    {
      href: () => config.siteOrigin,
      referrer: () => "",
      now: () => now,
      uuid: () => crypto.randomUUID(),
      warn: vi.fn(),
      fetch: fetcher,
    },
    new Set(["purchase"]),
  );
  t.update({ analytics_storage: "granted" }, 500);
  now += 600;
  t.exit(0);
  t.update({ analytics_storage: "denied" });
  t.track("purchase");
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/d"))).toBe(false);
});
for (const target of [16320, 16370])
  it(`preserves a ${target} byte non-item conversion by removing labels last`, () => {
    const url = new URL(
      "https://www.google-analytics.com/g/collect?en=purchase&ep.transaction_id=one",
    );
    const base = new URLSearchParams(url.search).toString();
    url.searchParams.set(
      "ep.payload",
      "x".repeat(target - Buffer.byteLength(base) - "&ep.payload=".length),
    );
    url.searchParams.set("ep.vv_type", "agent_verified");
    url.searchParams.set(
      "ep.vv_detail",
      "openai|signature_valid|user_directed|signature_agent|human|final",
    );
    const request = collectRequest(url);
    expect(request).toBeDefined();
    const body = new URLSearchParams(request!.body);
    expect(body.get("ep.transaction_id")).toBe("one");
    expect(body.has("ep.vv_detail")).toBe(false);
    expect(body.has("ep.vv_type")).toBe(target === 16320);
    expect(Buffer.byteLength(request!.body!)).toBeLessThanOrEqual(16384);
  });
it("passes query settings from the served script into browser requests", async () => {
  const { createApp: builtApp } = await import(
    new URL("../dist/server/app.js", import.meta.url).href
  );
  const app = builtApp({ ...config, keepQueryParams: ["vvp"] });
  apps.push(app);
  const response = await app.inject("/s.js");
  expect(response.statusCode).toBe(200);
  const assignment = response.body.match(
    /document.currentScript.dataset.keepQueryParams=("[^"]*");/,
  );
  expect(assignment).not.toBeNull();
  const p = page([["consent", "update", { analytics_storage: "granted" }]], {
    source: response.body,
    setup(host) {
      (host.location as { href: string }).href = config.siteOrigin + "/?vvp=test&private=secret";
    },
  });
  expect(JSON.parse(String(p.fetcher.mock.calls[0]![1]?.body)).params.page_location).toBe(
    config.siteOrigin + "/?vvp=test",
  );
});
for (const key of ["FILTER_OBVIOUS_BOTS", "KEEP_QUERY_PARAMS"])
  it(`rejects invalid ${key}`, () => {
    const env = { GA4_MEASUREMENT_ID: "G-TEST", COOKIE_SECRET: "s".repeat(64) };
    expect(() =>
      configFromEnv({ ...env, [key]: key === "KEEP_QUERY_PARAMS" ? "vvp,unsafe=x" : "yes" }),
    ).toThrow(key);
  });

it("binds retry proof to all covered headers and semantic event data", () => {
  const e = {
    ...event(),
    consent: consentSnapshot({ analytics_storage: "granted" }),
    params: { value: 1, traffic_class: "human", traffic_phase: "initial" },
  };
  const req = {
    ip: "192.0.2.1",
    method: "POST",
    url: "/e",
    headers: {
      "signature-input": 'sig=("@method" "x-proof");created=1',
      signature: "sig=:abc:",
      "x-proof": "one",
      "user-agent": "Browser",
      cookie: "one",
      "x-request-id": "one",
    },
  };
  const fingerprint = retryFingerprint(e, req);
  expect(
    retryFingerprint(
      { ...e, params: { traffic_phase: "final", value: 1, traffic_class: "automated" } },
      { ...req, headers: { ...req.headers, cookie: "two", "x-request-id": "two" } },
    ),
  ).toBe(fingerprint);
  for (const key of ["signature", "signature-input", "x-proof", "user-agent"] as const)
    expect(retryFingerprint(e, { ...req, headers: { ...req.headers, [key]: "changed" } })).not.toBe(
      fingerprint,
    );
  for (const changed of [
    { ...e, event_id: crypto.randomUUID() },
    { ...e, params: { value: 2 } },
    { ...e, params: { ...e.params, traffic_custom: "changed" } },
    { ...e, consent: consentSnapshot({ analytics_storage: "denied" }) },
  ])
    expect(retryFingerprint(changed, req)).not.toBe(fingerprint);
  for (const field of ["ip", "method", "url"] as const)
    expect(retryFingerprint(e, { ...req, [field]: "changed" })).not.toBe(fingerprint);
  expect(retryFingerprint({ ...e, name: "traffic_class" }, req)).not.toBe(
    retryFingerprint(
      { ...e, name: "traffic_class", params: { ...e.params, traffic_phase: "final" } },
      req,
    ),
  );
  const signedCookie = {
    ...req,
    headers: { ...req.headers, "signature-input": 'sig=("cookie")', cookie: "one" },
  };
  expect(retryFingerprint(e, signedCookie)).not.toBe(
    retryFingerprint(e, { ...signedCookie, headers: { ...signedCookie.headers, cookie: "two" } }),
  );
});
for (const mode of ["visibilitychange", "SPA"] as const)
  it(`${mode} keeps a 503 purchase retry and publishes its B7 echo`, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const p = page([], {
      dataset: { verdictEcho: "on" },
      context: { TextDecoder, setTimeout, clearTimeout },
    });
    let finish!: (r: Response) => void;
    let purchases = 0;
    p.fetcher.mockImplementation((_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.name === "page_view" && purchases === 0)
        return new Promise((resolve) => {
          finish = resolve;
        });
      if (body.name === "purchase") {
        if (++purchases === 1) return Promise.resolve(new Response(null, { status: 503 }));
        return Promise.resolve(
          Response.json({
            vv: {
              v: 1,
              ttl: 60,
              type: "agent_verified",
              operator: "openai",
              verification: "signature_valid",
              purpose: "user_directed",
            },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    p.command("consent", "update", { analytics_storage: "granted" });
    p.command("event", "purchase", { transaction_id: "one" });
    if (mode === "SPA") p.host.history.pushState({}, "", config.siteOrigin + "/next");
    else {
      p.doc.visibilityState = "hidden";
      p.doc.dispatchEvent(new Event("visibilitychange"));
    }
    await settle();
    finish(new Response(null, { status: 204 }));
    await settle();
    vi.setSystemTime(Date.now() + 1100);
    (p.host.setInterval.mock.calls[0]![0] as () => void)();
    await settle();
    expect(purchases).toBe(2);
    expect(
      (p.host as unknown as { __visitorVerdictServer: { operator: string } }).__visitorVerdictServer
        ?.operator,
    ).toBe("openai");
  });
it("immediate engagement responses also reach verdict processing", async () => {
  const verdict = vi.fn(async () => {});
  const t = createTracker(
    "https://tracker.example/e",
    {
      href: () => config.siteOrigin,
      referrer: () => "",
      now: Date.now,
      uuid: () => crypto.randomUUID(),
      warn: vi.fn(),
      fetch: async () => new Response(null, { status: 204 }),
      verdict,
    },
    new Set(),
  );
  t.update({ analytics_storage: "granted" });
  await settle();
  t.exit(1);
  await settle();
  expect(verdict).toHaveBeenCalledTimes(2);
});
it("does not count obvious UAs on hits that cannot fit the wire budget", async () => {
  const { app, google } = appSetup();
  const params = Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => ["custom" + i, "😀".repeat(100)]),
  );
  await app.inject({
    method: "POST",
    url: "/e",
    headers: { origin: config.siteOrigin, "user-agent": "HeadlessChrome" },
    payload: { ...event(), params },
  });
  expect(google).not.toHaveBeenCalled();
  expect((await app.inject("/health")).json().google.botsLabelled).toBe(0);
});
