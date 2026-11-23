import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { createTracker } from "../src/client/tracker.js";
import { configFromEnv } from "../src/server/config.js";
const config = {
  siteOrigin: "https://shop.example",
  measurementId: "G-TEST",
  cookieSecret: "s".repeat(64),
};
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
const event = () => ({
  name: "purchase",
  event_id: crypto.randomUUID(),
  client_id: "1.2",
  session_id: 1,
  session_started_ms: Date.now(),
  session_expires_ms: Date.now() + 1800000,
  timestamp_ms: Date.now(),
  consent: { analytics_storage: "granted" },
  params: {},
});
for (const route of ["/d", "/e"]) {
  it(`labels obvious bots on ${route}`, async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const app = createApp(config, fetcher);
    apps.push(app);
    const payload =
      route === "/e"
        ? event()
        : {
            name: "purchase",
            client_id: "1.2",
            session_id: 1,
            page_id: "1",
            hit_index: 1,
            consent: { analytics_storage: "denied" },
            params: {},
          };
    expect(
      (
        await app.inject({
          method: "POST",
          url: route,
          headers: { origin: config.siteOrigin, "user-agent": "HeadlessChrome/130" },
          payload,
        })
      ).statusCode,
    ).toBe(204);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(
      new URLSearchParams(new URL(String(url)).search + "&" + (init?.body ?? "")).get("ep.vv_type"),
    ).toBe("bot_automation");
    expect((await app.inject("/health")).json().google.botsLabelled).toBe(1);
  });
  it(`rejects deeply nested params on ${route}`, async () => {
    const app = createApp(config, vi.fn());
    apps.push(app);
    let params: object = {};
    for (let i = 0; i < 40; i++) params = { a: params };
    const payload =
      route === "/e"
        ? { ...event(), params }
        : {
            name: "purchase",
            client_id: "1.2",
            session_id: 1,
            page_id: "1",
            hit_index: 1,
            consent: { analytics_storage: "denied" },
            params,
          };
    expect(
      (
        await app.inject({
          method: "POST",
          url: route,
          headers: { origin: config.siteOrigin },
          payload,
        })
      ).statusCode,
    ).toBe(400);
  });
}
function tracker() {
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
  return {
    t,
    fetcher,
    advance: () => {
      now += 60000;
    },
    names: () => fetcher.mock.calls.map(([, i]) => JSON.parse(String(i?.body)).name),
  };
}
it("hands pending conversions and class updates to transport on exit", () => {
  const { t, names, fetcher } = tracker();
  t.update({ analytics_storage: "granted" });
  t.track("purchase", { transaction_id: "one" });
  t.track("traffic_class", { traffic_class: "automated", traffic_phase: "final" });
  t.exit(1);
  t.exit(0);
  expect(names()).toEqual(["page_view", "purchase", "traffic_class", "page_engagement"]);
  for (const [, init] of fetcher.mock.calls) expect(init?.keepalive).toBe(true);
});
it("shares the two traffic phases across consent transports", async () => {
  const { t, fetcher, names } = tracker();
  fetcher.mockResolvedValue(new Response(null, { status: 204 }));
  t.update({ analytics_storage: "denied" });
  const final = { traffic_class: "automated", traffic_phase: "final" },
    agent = { traffic_class: "declared_agent", traffic_phase: "agent", traffic_agent: "openai" };
  t.track("traffic_class", final);
  t.track("traffic_class", agent);
  t.update({ analytics_storage: "granted" });
  t.track("traffic_class", final);
  t.track("traffic_class", agent);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  expect(names().filter((n) => n === "traffic_class")).toHaveLength(2);
});
it("delivers a traffic update released after sixty seconds awaiting consent", async () => {
  const { t, fetcher, names, advance } = tracker();
  fetcher.mockResolvedValue(new Response(null, { status: 204 }));
  t.track("traffic_class", { traffic_class: "automated", traffic_phase: "final" });
  advance();
  t.update({ analytics_storage: "granted" });
  for (let i = 0; i < 30; i++) await Promise.resolve();
  expect(names()).toEqual(["page_view", "traffic_class"]);
});
it("parses query allowlist and disabled-by-default bot filtering", () => {
  const env = { GA4_MEASUREMENT_ID: "G-TEST", COOKIE_SECRET: "s".repeat(64) };
  expect(configFromEnv(env)).toMatchObject({ keepQueryParams: [], filterObviousBots: false });
  expect(
    configFromEnv({ ...env, KEEP_QUERY_PARAMS: "vvp, test", FILTER_OBVIOUS_BOTS: "on" }),
  ).toMatchObject({ keepQueryParams: ["vvp", "test"], filterObviousBots: true });
});

it("keeps configured query markers through browser and both collector routes", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const app = createApp({ ...config, keepQueryParams: ["vvp"] }, fetcher);
  apps.push(app);
  const browserFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const t = createTracker(
    "https://tracker.example/e",
    {
      keepQueryParams: ["vvp"],
      href: () => config.siteOrigin + "/?vvp=test&private=no#fragment",
      referrer: () => "",
      now: Date.now,
      uuid: () => crypto.randomUUID(),
      warn: vi.fn(),
      fetch: browserFetch,
    },
    new Set(),
  );
  t.update({ analytics_storage: "granted" });
  const body = JSON.parse(String(browserFetch.mock.calls[0]![1]?.body));
  expect(body.params.page_location).toBe(config.siteOrigin + "/?vvp=test");
  for (const route of ["/e", "/d"]) {
    const payload =
      route === "/e"
        ? body
        : {
            name: "page_view",
            client_id: "1.2",
            session_id: 1,
            page_id: "1",
            hit_index: 1,
            consent: { analytics_storage: "denied" },
            params: body.params,
          };
    expect(
      (
        await app.inject({
          method: "POST",
          url: route,
          headers: { origin: config.siteOrigin },
          payload,
        })
      ).statusCode,
    ).toBe(204);
    expect(new URL(String(fetcher.mock.calls.at(-1)![0])).searchParams.get("dl")).toBe(
      config.siteOrigin + "/?vvp=test",
    );
  }
});

it("never exports arbitrary custom email fields or items in denied pings", async () => {
  const email = "alice@example.test";
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const app = createApp(config, fetcher);
  apps.push(app);
  const params = {
    page_title: "Title",
    page_location: config.siteOrigin + "/?utm_source=test&email=private",
    value: 12,
    currency: "CZK",
    email,
    custom: email,
    unknown: { nested: email },
    items: [{ item_name: email }],
    transaction_id: email,
    user_data: { email },
  };
  const browserFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const t = createTracker(
    "https://tracker.example/e",
    {
      href: () => config.siteOrigin,
      referrer: () => "",
      title: () => "Title",
      now: Date.now,
      uuid: () => crypto.randomUUID(),
      warn: vi.fn(),
      fetch: browserFetch,
    },
    new Set(["purchase"]),
  );
  t.update({ analytics_storage: "denied" });
  t.track("purchase", params);
  const browserBody = JSON.parse(String(browserFetch.mock.calls.at(-1)![1]?.body));
  expect(JSON.stringify(browserBody)).not.toContain(email);
  expect(browserBody.params.items).toBeUndefined();
  for (const body of [browserBody, { ...browserBody, params }]) {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/d",
          headers: { origin: config.siteOrigin, "user-agent": "Chrome/140" },
          payload: body,
        })
      ).statusCode,
    ).toBe(204);
    const [url, init] = fetcher.mock.calls.at(-1)!;
    expect(String(url) + String(init?.body ?? "")).not.toContain(encodeURIComponent(email));
    const fields = new URLSearchParams(new URL(String(url)).search + "&" + (init?.body ?? ""));
    expect(fields.get("epn.value")).toBe("12");
    expect(fields.get("cu")).toBe("CZK");
    expect(fields.get("dt")).toBe("Title");
    expect(fields.has("_uip")).toBe(true);
    expect(fields.get("ep.transaction_id")).toBeNull();
  }
});

it("retains a bounded Visitor Verdict claim on the dedicated denied update", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const app = createApp(config, fetcher);
  apps.push(app);
  const payload = {
    name: "traffic_class",
    client_id: "1.2",
    session_id: 1,
    page_id: "1",
    hit_index: 1,
    consent: { analytics_storage: "denied" },
    params: {
      traffic_class: "declared_agent",
      traffic_phase: "agent",
      traffic_agent: "openai",
      traffic_agent_claim: "dom_host",
    },
  };
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/d",
        headers: { origin: config.siteOrigin },
        payload,
      })
    ).statusCode,
  ).toBe(204);
  expect(
    new URL(String(fetcher.mock.calls[0]![0])).searchParams.get("ep.traffic_agent_claim"),
  ).toBe("dom_host");
});
