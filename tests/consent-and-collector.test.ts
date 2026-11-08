import { afterEach, expect, it, vi } from "vitest";
import { page } from "./browser-fixture.js";
import { createConsentObserver } from "../src/client/consent.js";
import { cookiebot } from "../src/client/cmp/cookiebot.js";
import { cookieconsent } from "../src/client/cmp/cookieconsent.js";
import { createApp } from "../src/server/app.js";
import type { TrackingEvent } from "../src/shared/event.js";
import { normalizeConsent } from "../src/shared/consent.js";

const granted = {
  analytics_storage: "granted",
  ad_storage: "granted",
  ad_user_data: "granted",
  ad_personalization: "granted",
};
afterEach(() => vi.useRealTimers());
const tick = async (p: ReturnType<typeof page>, ms: number) => {
  vi.advanceTimersByTime(ms);
  (p.host.setInterval.mock.calls[0]![0] as () => void)();
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
it("regional purposes remain unknown despite general grants, until explicit update", () => {
  for (const reversed of [false, true]) {
    const observer = createConsentObserver();
    const commands = [
      ["consent", "default", { ...granted, region: ["CZ"] }],
      ["consent", "default", granted],
    ];
    (reversed ? commands.reverse() : commands).forEach((command) => observer.observe(command));
    expect(observer.snapshot().analytics_storage).toBe("unknown");
    expect(observer.snapshot().ad_user_data).toBe("unknown");
    observer.observe(["consent", "update", granted]);
    expect(observer.snapshot()).toEqual(granted);
  }
});
it("inline purchase before the deferred script is delivered once, in order", async () => {
  const p = page([
    ["consent", "update", granted],
    {
      event: "purchase",
      ecommerce: { transaction_id: "inline", items: [{ item_id: "one" }] },
    },
  ]);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(p.fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(p.fetcher.mock.calls[1]![1]?.body)).params.transaction_id).toBe(
    "inline",
  );
});
it("unknown inline purchase waits for a late CMP grant and preserves its timestamp", async () => {
  vi.useFakeTimers();
  const start = Date.now();
  const p = page([{ event: "purchase", transaction_id: "late" }]);
  expect(p.fetcher).not.toHaveBeenCalled();
  await tick(p, 500);
  p.command("consent", "update", granted);
  await tick(p, 0);
  expect(p.fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(p.fetcher.mock.calls[1]![1]?.body)).timestamp_ms).toBe(start);
});
it("unknown events expire after two seconds without reading cookies or sending", async () => {
  vi.useFakeTimers();
  const p = page([{ event: "generate_lead" }]);
  await tick(p, 2001);
  p.command("consent", "update", granted);
  expect(
    p.fetcher.mock.calls.every(([, o]) => JSON.parse(String(o?.body)).name === "page_view"),
  ).toBe(true);
  expect(p.cookieReads()).toBe(0);
});
it("granted default also respects wait_for_update; excessive waits are capped", async () => {
  vi.useFakeTimers();
  const p = page([
    ["consent", "default", { ...granted, wait_for_update: 99999 }],
    { event: "generate_lead" },
  ]);
  await tick(p, 1999);
  expect(p.fetcher).not.toHaveBeenCalled();
  await tick(p, 1);
  expect(p.fetcher).toHaveBeenCalledTimes(2);
});
it("gtag events reach the collector with relative URL fields cleaned", async () => {
  vi.useFakeTimers();
  const p = page([["consent", "update", granted]]);
  await tick(p, 0);
  expect(p.fetcher).toHaveBeenCalledTimes(1);
  p.command("event", "generate_lead", {
    page_location: "/checkout?email=private&customer_id=123&utm_source=test#secret",
    page_referrer: "//shop.example/?visitor_id=123#secret",
  });
  await tick(p, 0);
  expect(p.fetcher).toHaveBeenCalledTimes(2);
  const body = JSON.parse(String(p.fetcher.mock.calls[1]![1]?.body));
  expect(body.params.page_location).toBe("/checkout?utm_source=test");
  expect(body.params.page_referrer).toBe("//shop.example/");
});
it("bad items never break original push or following items", () => {
  const p = page([["consent", "update", granted]]);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(() =>
    p.host.dataLayer.push(
      { event: "generate_lead", context: circular },
      { event: "generate_lead", value: 1 },
    ),
  ).not.toThrow();
  expect(p.host.dataLayer).toHaveLength(3);
  expect(p.fetcher).toHaveBeenCalledTimes(1);
});
it("undecided adapters stay unknown until a response is valid", () => {
  const host = Object.assign(new EventTarget(), {
    Cookiebot: {
      hasResponse: false,
      consent: { statistics: false, marketing: false },
    },
    CookieConsent: { validConsent: () => false, acceptedCategory: () => true },
  });
  expect(cookiebot(host).read()?.analytics_storage).toBe("unknown");
  expect(cookieconsent(host).read()?.analytics_storage).toBe("unknown");
});
function event(): TrackingEvent {
  const now = Date.now();
  return {
    event_id: crypto.randomUUID(),
    name: "generate_lead",
    client_id: "123.456",
    session_id: Math.floor(now / 1000),
    session_started_ms: now - 1000,
    session_expires_ms: now + 1800000,
    timestamp_ms: now,
    consent: normalizeConsent(granted),
    params: {
      page_location: "/checkout?email=private&id=123&utm_source=test#secret",
      page_referrer: "//shop.example/?id=123#secret",
    },
  };
}
it("limits a spoofed origin sender without blocking another IP", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const app = createApp(
    {
      cookieSecret: "s".repeat(64),
      measurementId: "G-TEST",
      siteOrigin: "https://shop.example",
    },
    fetcher,
  );
  const post = (ip: string) =>
    app.inject({
      method: "POST",
      url: "/e",
      remoteAddress: ip,
      headers: { origin: "https://shop.example" },
      payload: event(),
    });
  try {
    for (let i = 0; i < 300; i++) expect((await post("192.0.2.1")).statusCode).toBe(204);
    expect((await post("192.0.2.1")).statusCode).toBe(429);
    expect((await post("192.0.2.2")).statusCode).toBe(204);
    // Each accepted event is exactly one hit.
    expect(fetcher).toHaveBeenCalledTimes(301);
  } finally {
    await app.close();
  }
});

it("full deduplication map evicts old entries instead of blocking a new visitor", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const app = createApp(
    {
      cookieSecret: "s".repeat(64),
      measurementId: "G-TEST",
      siteOrigin: "https://shop.example",
    },
    fetcher,
  );
  const post = (ip: string) =>
    app.inject({
      method: "POST",
      url: "/e",
      remoteAddress: ip,
      headers: { origin: "https://shop.example" },
      payload: event(),
    });
  try {
    for (let i = 0; i < 10000; i++)
      expect((await post(`192.0.2.${Math.floor(i / 50) + 1}`)).statusCode).toBe(204);
    expect((await post("192.0.2.250")).statusCode).toBe(204);
    expect(fetcher).toHaveBeenCalledTimes(10001);
  } finally {
    await app.close();
  }
}, 20000);

it("concurrency limits apply per IP and globally, then release slots", async () => {
  let finish!: () => void;
  const deferred = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const fetcher = vi.fn<typeof fetch>(async () => {
    await deferred;
    return new Response(null, { status: 204 });
  });
  const app = createApp(
    {
      cookieSecret: "s".repeat(64),
      measurementId: "G-TEST",
      siteOrigin: "https://shop.example",
    },
    fetcher,
  );
  let visitor = 0;
  const post = (ip = "192.0.2.1") =>
    app.inject({
      method: "POST",
      url: "/e",
      remoteAddress: ip,
      headers: { origin: "https://shop.example" },
      // Separate visitors: events of one visitor wait for that visitor's session to open.
      payload: { ...event(), client_id: `${++visitor}.1` },
    });
  try {
    const pending = Array.from({ length: 100 }, (_, i) =>
      post(`192.0.2.${Math.floor(i / 10) + 1}`).then((r) => r.statusCode),
    );
    while (fetcher.mock.calls.length < 100) await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await post("192.0.2.1")).statusCode).toBe(429);
    expect((await post("192.0.2.20")).statusCode).toBe(429);
    finish();
    expect(await Promise.all(pending)).toEqual(Array(100).fill(204));
    expect((await post()).statusCode).toBe(204);
  } finally {
    finish();
    await app.close();
  }
});

it("deep malformed event is rejected without outgoing calls and health stays available", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const app = createApp(
    {
      cookieSecret: "s".repeat(64),
      measurementId: "G-TEST",
      siteOrigin: "https://shop.example",
    },
    fetcher,
  );
  let nested: unknown = 0;
  for (let i = 0; i < 100; i++) nested = { nested };
  try {
    const response = await app.inject({
      method: "POST",
      url: "/e",
      headers: { origin: "https://shop.example" },
      payload: { ...event(), params: { nested } },
    });
    expect(response.statusCode).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  } finally {
    await app.close();
  }
});

it("late supported CMP readiness releases pending cookie events", async () => {
  vi.useFakeTimers();
  const p = page([{ event: "generate_lead" }]);
  await tick(p, 300);
  Object.assign(p.host, {
    Cookiebot: {
      hasResponse: true,
      consent: { statistics: true, marketing: false },
    },
  });
  p.host.dispatchEvent(new Event("CookiebotOnConsentReady"));
  expect(p.fetcher).toHaveBeenCalledTimes(1);
});

it("unresolved cookie consent produces a clear diagnostic after two seconds", () => {
  const p = page();
  (p.host.setTimeout.mock.calls[0]![0] as () => void)();
  expect(p.warnings).toHaveBeenCalledWith(
    expect.stringContaining("GTM Consent API alone is not visible"),
  );
});

it("grant after an expired unknown window does not resurrect a cookie event", async () => {
  vi.useFakeTimers();
  const p = page([{ event: "generate_lead" }]);
  vi.advanceTimersByTime(2001);
  p.command("consent", "update", granted);
  expect(
    p.fetcher.mock.calls.every(([, o]) => JSON.parse(String(o?.body)).name === "page_view"),
  ).toBe(true);
});

it("production trusts only the immediate private proxy hop for IP limits", async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const app = createApp(
    {
      cookieSecret: "s".repeat(64),
      measurementId: "G-TEST",
      siteOrigin: "https://shop.example",
    },
    fetcher,
  );
  const post = (prefix: string, client: string) =>
    app.inject({
      method: "POST",
      url: "/e",
      headers: {
        origin: "https://shop.example",
        "x-forwarded-for": `${prefix}, ${client}`,
      },
      payload: event(),
    });
  try {
    for (let i = 0; i < 300; i++)
      expect((await post(`192.0.2.${i + 1}`, "192.0.2.200")).statusCode).toBe(204);
    expect((await post("192.0.2.61", "192.0.2.200")).statusCode).toBe(429);
    expect((await post("192.0.2.61", "192.0.2.201")).statusCode).toBe(204);
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

it("a decided banner resolves a regional default without a direct consent update", async () => {
  const p = page([["consent", "default", { analytics_storage: "denied", region: ["CZ"] }]]);
  Object.assign(p.host, {
    Cookiebot: { hasResponse: true, consent: { statistics: true, marketing: false } },
  });
  p.host.dispatchEvent(new Event("CookiebotOnConsentReady"));
  p.command("event", "generate_lead");
  for (let i = 0; i < 30; i++) await Promise.resolve();
  expect(p.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/e")).length).toBeGreaterThan(
    0,
  );
});
