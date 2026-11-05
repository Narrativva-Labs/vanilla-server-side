import { afterEach, expect, it, vi } from "vitest";
import { serverIdentity, COOKIE_NAME } from "../src/server/identity.js";
import { createApp } from "../src/server/app.js";
import { normalizeConsent } from "../src/shared/consent.js";
import { campaignDetails } from "../src/client/campaign.js";
import { page } from "./browser-fixture.js";
import { configFromEnv } from "../src/server/config.js";
import { execFileSync } from "node:child_process";
const config = {
  siteOrigin: "https://www.example.com",
  cookieDomain: "example.com",
  cookieSecret: "s".repeat(64),
  measurementId: "G-TEST",
  apiSecret: "test",
};
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());
it("signed identity persists, rotates sessions after inactivity and rejects modification", () => {
  const start = Date.now();
  const first = serverIdentity(config, "", start);
  expect(first.clientId).toMatch(/^\d+\.\d+$/);
  expect(first.cookie).toContain("HttpOnly; Secure; SameSite=Lax");
  expect(first.cookie).toContain("Domain=example.com");
  const next = serverIdentity(config, first.cookie, start + 10000);
  expect(next.clientId).toBe(first.clientId);
  expect(next.sessionId).toBe(first.sessionId);
  expect(next.newSession).toBe(false);
  const expired = serverIdentity(config, next.cookie, start + 1810000);
  expect(expired.clientId).toBe(first.clientId);
  expect(expired.sessionId).not.toBe(first.sessionId);
  expect(expired.newSession).toBe(true);
  expect(serverIdentity(config, first.cookie.replace("=", "=broken"), start).clientId).not.toBe(
    first.clientId,
  );
});
for (const mode of ["cookie", "cookieless"] as const) {
  it(`${mode}: server consent, credentials, device, campaign, geography and health`, async () => {
    const google = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const app = createApp({ ...config, mode }, google);
    const now = Date.now();
    const event = {
      event_id: crypto.randomUUID(),
      name: "page_view",
      client_id: "123.456",
      session_id: 123,
      session_started_ms: now,
      session_expires_ms: now + 1800000,
      timestamp_ms: now,
      consent: normalizeConsent({ analytics_storage: "granted" }),
      params: { engagement_time_msec: 50 },
      campaign: { source: "newsletter", medium: "email" },
      device: {
        browser: "Firefox",
        model: "Phone",
        category: "mobile",
        language: "cs",
        screen_resolution: "360x800",
      },
    };
    const post = (payload: object, cookie = "") =>
      app.inject({
        method: "POST",
        url: "/e",
        headers: { origin: config.siteOrigin, cookie },
        payload,
      });
    try {
      for (const state of ["denied", ...(mode === "cookie" ? ["unknown"] : [])]) {
        const response = await post({ ...event, consent: { analytics_storage: state } });
        expect(response.statusCode).toBe(403);
        expect(response.headers["set-cookie"]).toBeUndefined();
      }
      const response = await post(event);
      expect(response.statusCode).toBe(204);
      expect(response.headers["access-control-allow-credentials"]).toBe("true");
      const body = JSON.parse(String(google.mock.calls[0]![1]?.body));
      expect(body.device).toEqual(event.device);
      expect(body.events.map((e: { name: string }) => e.name)).toEqual([
        "campaign_details",
        "page_view",
      ]);
      expect(body.events[1].params.engagement_time_msec).toBe(50);
      expect(body.consent).toEqual({ ad_user_data: "DENIED", ad_personalization: "DENIED" });
      expect(body.ip_override).toBe(mode === "cookie" ? "127.0.0.1" : undefined);
      if (mode === "cookie") {
        expect(body.client_id).not.toBe(event.client_id);
        const cookie = String(response.headers["set-cookie"]);
        await post({ ...event, event_id: crypto.randomUUID() }, cookie);
        const second = JSON.parse(String(google.mock.calls[1]![1]?.body));
        expect(second.client_id).toBe(body.client_id);
        expect(second.events.map((e: { name: string }) => e.name)).toEqual(["page_view"]);
      } else expect(response.headers["set-cookie"]).toBeUndefined();
      const deleted = await app.inject({
        method: "POST",
        url: "/p",
        headers: { origin: config.siteOrigin },
        payload: {},
      });
      if (mode === "cookie")
        expect(deleted.headers["set-cookie"]).toContain(
          `${COOKIE_NAME}=; Path=/; Domain=example.com; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
        );
      else expect(deleted.headers["set-cookie"]).toBeUndefined();
      const preflight = await app.inject({
        method: "OPTIONS",
        url: "/e",
        headers: { origin: config.siteOrigin },
      });
      expect(preflight.headers["access-control-allow-credentials"]).toBe("true");
      const health = (await app.inject("/health")).json();
      expect(health.google.sent).toBe(mode === "cookie" ? 2 : 1);
      expect(health.google.errors).toBe(0);
      expect(health.google.lastSuccess).toEqual(expect.any(String));
    } finally {
      await app.close();
    }
  });
  it(`${mode}: SPA deduplication, visible engagement and keepalive`, async () => {
    vi.useFakeTimers();
    const p = page(mode, [["consent", "update", { analytics_storage: "granted" }]]);
    await settle();
    vi.advanceTimersByTime(1200);
    p.host.history.pushState({}, "", "https://shop.example/next");
    p.host.dispatchEvent(new Event("popstate"));
    await settle();
    vi.advanceTimersByTime(500);
    p.doc.visibilityState = "hidden";
    p.doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    vi.advanceTimersByTime(8000);
    p.host.dispatchEvent(new Event("pagehide"));
    await settle();
    const events = p.fetcher.mock.calls.map(([, o]) => JSON.parse(String(o?.body)));
    expect(events.filter((e) => e.name === "page_view")).toHaveLength(2);
    expect(events[1].params.page_title).toBe("Shop");
    expect(events.reduce((sum, e) => sum + e.params.engagement_time_msec, 0)).toBe(1700);
    expect(events.at(-1).name).toBe("page_engagement");
    for (const [, options] of p.fetcher.mock.calls) {
      expect(options?.keepalive).toBe(true);
      expect(options?.credentials).toBe(mode === "cookie" ? "include" : "omit");
    }
    expect(p.cookieReads()).toBe(0);
  });
}
it("campaign mapping uses documented field names and never transports click IDs", () => {
  expect(
    campaignDetails(
      "https://example.com/?utm_id=a&utm_campaign=b&utm_source=c&utm_medium=d&utm_term=e&utm_content=f",
      "",
    ),
  ).toEqual({ campaign_id: "a", campaign: "b", source: "c", medium: "d", term: "e", content: "f" });
  expect(campaignDetails("https://example.com/?gclid=secret", "")).toEqual({
    source: "google",
    medium: "cpc",
  });
  expect(campaignDetails("https://example.com/?gclid=secret", "", false)).toEqual({
    source: "(direct)",
    medium: "(none)",
  });
  expect(campaignDetails("https://example.com/", "https://www.google.cz/search")).toEqual({
    source: "google",
    medium: "organic",
  });
  expect(campaignDetails("https://example.com/", "https://other.example/path")).toEqual({
    source: "other.example",
    medium: "referral",
  });
});
it("configuration requires a strong signing secret in cookie mode", () => {
  const env = {
    SITE_ORIGIN: config.siteOrigin,
    GA4_MEASUREMENT_ID: "G-TEST",
    GA4_API_SECRET: "test",
  };
  expect(() => configFromEnv(env)).toThrow("COOKIE_SECRET");
  expect(() =>
    configFromEnv({ ...env, COOKIE_SECRET: "replace-with-at-least-32-random-characters" }),
  ).toThrow("COOKIE_SECRET");
  expect(configFromEnv({ ...env, COOKIE_SECRET: config.cookieSecret }).cookieDomain).toBe(
    "example.com",
  );
  expect(() => configFromEnv({ ...env, TRACKING_MODE: "cookieless" })).not.toThrow();
});
it("installation and update scripts have valid bash syntax", () => {
  execFileSync("bash", ["-n", "install.sh", "update.sh"]);
});
for (const mode of ["cookie", "cookieless"] as const) {
  it(`${mode}: ecommerce forms, gtag events and purchase deduplication`, async () => {
    const p = page(mode, [["consent", "update", { analytics_storage: "granted" }]]);
    await settle();
    const ecommerce = {
      currency: "EUR",
      value: 42,
      items: [{ item_id: "book", price: 42, quantity: 1 }],
    };
    p.host.dataLayer.push({ event: "add_to_cart", ecommerce });
    p.command("event", "begin_checkout", ecommerce);
    p.host.dataLayer.push({ event: "purchase", ...ecommerce, transaction_id: "once" });
    p.command("event", "purchase", { ...ecommerce, transaction_id: "once" });
    await settle();
    const events = p.fetcher.mock.calls.map(([, o]) => JSON.parse(String(o?.body)));
    expect(events.map((e) => e.name)).toEqual([
      "page_view",
      "add_to_cart",
      "begin_checkout",
      "purchase",
    ]);
    for (const e of events.slice(1)) expect(e.params).toMatchObject(ecommerce);
  });
}
it("a newer Google denial beats a banner grant that has not changed", async () => {
  const p = page("cookie");
  Object.assign(p.host, {
    Cookiebot: { hasResponse: true, consent: { statistics: true, marketing: false } },
  });
  p.host.dispatchEvent(new Event("CookiebotOnConsentReady"));
  await settle();
  p.command("consent", "update", { analytics_storage: "denied" });
  p.host.dispatchEvent(new Event("CookiebotOnConsentReady"));
  p.command("event", "generate_lead");
  await settle();
  expect(p.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/e"))).toHaveLength(1);
  expect(String(p.fetcher.mock.calls.at(-1)?.[0])).toMatch(/\/p$/);
});
it("health counts failed Google delivery without logging payloads or secrets", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const google = vi.fn<typeof fetch>(async () => {
    throw Error("private upstream detail");
  });
  const app = createApp({ ...config, mode: "cookieless" }, google);
  const p = page("cookieless", [["consent", "update", { analytics_storage: "granted" }]]);
  await settle();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/e",
      headers: { origin: config.siteOrigin },
      payload: JSON.parse(String(p.fetcher.mock.calls[0]![1]?.body)),
    });
    expect(response.statusCode).toBe(503);
    expect((await app.inject("/health")).json().google).toEqual({
      sent: 0,
      errors: 1,
      botsFiltered: 0,
      lastSuccess: null,
    });
    expect(log.mock.calls).toEqual([["Google delivery failed", { outcome: "retry" }]]);
  } finally {
    log.mockRestore();
    await app.close();
  }
});
