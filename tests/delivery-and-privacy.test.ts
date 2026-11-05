import { afterEach, expect, it, vi } from "vitest";
import { page } from "./browser-fixture.js";
import { createTracker } from "../src/client/tracker.js";
import { createApp } from "../src/server/app.js";
import { normalizeConsent } from "../src/shared/consent.js";
import type { TrackingEvent } from "../src/shared/event.js";

afterEach(() => vi.useRealTimers());
const granted = { analytics_storage: "granted" };
const denied = { analytics_storage: "denied" };
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const flushPage = async (p: ReturnType<typeof page>) => {
  (p.host.setInterval.mock.calls[0]![0] as () => void)();
  await settle();
};
it("startup applies recorded withdrawal before beginning delivery", () => {
  const p = page("cookie", [
    ["consent", "update", granted],
    { event: "purchase", transaction_id: "before-withdrawal" },
    ["consent", "update", denied],
  ]);
  expect(p.fetcher.mock.calls.every(([url]) => String(url).endsWith("/p"))).toBe(true);
});
it("cookieless sends only one page view across withdrawal and regrant and ignores external page views", async () => {
  const p = page("cookieless", [
    ["consent", "update", granted],
    { event: "page_view" },
  ]);
  await settle();
  p.command("consent", "update", denied);
  p.command("consent", "update", granted);
  p.command("event", "page_view");
  p.host.dataLayer.push({ event: "page_view" });
  await flushPage(p);
  expect(
    p.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/e")).map(([, o]) => JSON.parse(String(o!.body)).name),
  ).toEqual(["page_view"]);
});
for (const original of ["denied", "granted"] as const)
  it(`ad updates preserve retry and never expand ${original} original permissions`, async () => {
    let now = Date.now();
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 503 }),
    );
    const tracker = createTracker(
      "https://kx7qpa.example.com/e",
        {
        
        now: () => now,
        uuid: () => crypto.randomUUID(),
        href: () => "https://shop.example/",
        referrer: () => "",
        warn: vi.fn(),
        fetch: fetcher,
      },
      new Set(["purchase"]),
    );
    tracker.update({
      ...granted,
      ad_user_data: original,
      ad_personalization: original,
    });
    tracker.track("purchase", { transaction_id: "keep" });
    await settle();
    expect(tracker.pending()).toBe(2);
    tracker.update({
      ...granted,
      ad_user_data: "denied",
      ad_personalization: "denied",
    });
    tracker.update({
      ...granted,
      ad_user_data: "granted",
      ad_personalization: "granted",
    });
    expect(tracker.pending()).toBe(2);
    now += 2000;
    await tracker.flush();
    expect(fetcher).toHaveBeenCalledTimes(4);
    const retry = JSON.parse(String(fetcher.mock.calls[3]![1]!.body));
    expect(retry.consent.ad_user_data).toBe("denied");
    expect(retry.consent.ad_personalization).toBe("denied");
    tracker.update(denied);
    expect(tracker.pending()).toBe(0);
  });
it("URL fields are sanitized at the client and independently at the Google boundary", async () => {
  const variants = [
    " https://shop.example/checkout?email=private#secret",
    "https:shop.example/checkout?email=private#secret",
    "checkout?email=private#secret",
    "\\\\shop.example\\checkout?email=private#secret",
  ];
  const fields = [
    "page_location",
    "page_referrer",
    "link_url",
    "checkout_url",
    "first_location",
    "previous_referrer",
  ];
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response(null, { status: 204 }),
  );
  const app = createApp(
    {
      cookieSecret: "s".repeat(64),
      measurementId: "G-TEST",
      apiSecret: "test-secret",
      mode: "cookieless",
      siteOrigin: "https://shop.example",
    },
    fetcher,
  );
  try {
    for (const variant of variants) {
      const params = Object.fromEntries(fields.map((key) => [key, variant]));
      const p = page("cookieless", [["consent", "update", granted]]);
      await settle();
      p.host.dataLayer.push({ event: "generate_lead", ...params });
      await flushPage(p);
      const client = JSON.parse(String(p.fetcher.mock.calls[1]![1]!.body));
      const now = Date.now();
      const event: TrackingEvent = {
        event_id: crypto.randomUUID(),
        name: "generate_lead",
        client_id: "123.456",
        session_id: Math.floor(now / 1000),
        session_started_ms: now - 1000,
        session_expires_ms: now + 1800000,
        timestamp_ms: now,
        consent: normalizeConsent(granted),
        params,
      };
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/e",
            headers: { origin: "https://shop.example" },
            payload: event,
          })
        ).statusCode,
      ).toBe(204);
      const server = JSON.parse(String(fetcher.mock.calls.at(-1)![1]!.body))
        .events[0].params;
      for (const field of fields) {
        expect(client.params[field]).not.toMatch(/private|email|secret|#/);
        expect(server[field]).toBe(client.params[field]);
      }
    }
  } finally {
    await app.close();
  }
});
it("oversized events are explained before fetch and independently rejected by the collector", async () => {
  const p = page("cookie", [["consent", "update", granted]]);
  await settle();
  p.fetcher.mockResolvedValueOnce(new Response(null, { status: 413 }));
  p.host.dataLayer.push({
    event: "purchase",
    transaction_id: "large",
    items: [{ item_name: "x".repeat(40000) }],
  });
  await flushPage(p);
  await flushPage(p);
  expect(p.fetcher).toHaveBeenCalledTimes(1);
  expect(p.warnings).toHaveBeenCalledWith(expect.stringContaining("32 KiB"));
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response(null, { status: 204 }),
  );
  const app = createApp(
    {
      cookieSecret: "s".repeat(64),
      measurementId: "G-TEST",
      apiSecret: "test-secret",
      siteOrigin: "https://shop.example",
    },
    fetcher,
  );
  try {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/e",
          headers: { origin: "https://shop.example" },
          payload: { ...JSON.parse(String(p.fetcher.mock.calls[0]![1]!.body)), params: { items: [{ item_name: "x".repeat(40000) }] } },
        })
      ).statusCode,
    ).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      (await app.inject({ method: "GET", url: "/health" })).statusCode,
    ).toBe(200);
  } finally {
    await app.close();
  }
});
it("withdrawal drops waiting purchases in either mode without replaying them", async () => {
  vi.useFakeTimers();
  for (const mode of ["cookie", "cookieless"] as const) {
    const p = page(mode, [
      ["consent", "default", { wait_for_update: 500 }],
      { event: "purchase", transaction_id: "discard" },
      ["consent", "update", denied],
    ]);
    expect(p.fetcher.mock.calls.every(([url]) => String(url).endsWith("/p"))).toBe(true);
    p.command("consent", "update", granted);
    vi.advanceTimersByTime(2000);
    await flushPage(p);
    expect(
      p.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/e")).map(([, o]) => JSON.parse(String(o!.body)).name),
    ).toEqual(["page_view"]);
  }
});

it("resolving unknown analytics never expands the waiting event advertising permissions", async () => {
  vi.useFakeTimers();
  const p = page("cookie", [
    [
      "consent",
      "default",
      { ad_user_data: "denied", ad_personalization: "denied" },
    ],
    { event: "generate_lead" },
  ]);
  vi.advanceTimersByTime(100);
  p.command("consent", "update", {
    analytics_storage: "granted",
    ad_storage: "granted",
    ad_user_data: "granted",
    ad_personalization: "granted",
  });
  await flushPage(p);
  expect(p.fetcher).toHaveBeenCalledTimes(2);
  const consent = JSON.parse(String(p.fetcher.mock.calls.find(([, o]) => JSON.parse(String(o?.body)).name === "generate_lead")![1]!.body)).consent;
  expect(consent.analytics_storage).toBe("granted");
  expect(consent.ad_user_data).toBe("denied");
  expect(consent.ad_personalization).toBe("denied");
});

it("each delivered event renews the signed cookie and a failed delivery does not", async () => {
  let status = 204;
  const google = vi.fn<typeof fetch>(async () => new Response(null, { status }));
  const site = "https://www.example.com";
  const app = createApp({ siteOrigin: site, cookieDomain: "example.com", cookieSecret: "s".repeat(64),
    measurementId: "G-TEST", apiSecret: "test" }, google);
  const send = (cookie?: string) => {
    const now = Date.now();
    return app.inject({ method: "POST", url: "/e", headers: { origin: site, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      payload: { event_id: crypto.randomUUID(), name: "generate_lead", client_id: "1.2", session_id: 1, session_started_ms: now,
        session_expires_ms: now + 1800000, timestamp_ms: now, consent: { analytics_storage: "granted" }, params: {} } });
  };
  try {
    const first = String((await send()).headers["set-cookie"]);
    expect(first).toContain("Max-Age=34560000");
    const cookie = first.split(";")[0]!;
    expect(String((await send(cookie)).headers["set-cookie"])).toContain("Max-Age=34560000");
    status = 503;
    const failed = await send(cookie);
    expect(failed.statusCode).toBe(503);
    expect(failed.headers["set-cookie"]).toBeUndefined();
  } finally { await app.close(); }
});
