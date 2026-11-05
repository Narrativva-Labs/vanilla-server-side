import { expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { isObviousBot } from "../src/server/bots.js";
import { configFromEnv } from "../src/server/config.js";
import { buildGoogleRequest } from "../src/server/google.js";
import { normalizeConsent } from "../src/shared/consent.js";

const granted = normalizeConsent({ analytics_storage: "granted" });
const env = { GA4_MEASUREMENT_ID: "G-TEST", GA4_API_SECRET: "test", COOKIE_SECRET: "s".repeat(64) };
const site = { siteOrigin: "https://www.example.com", cookieDomain: "example.com", cookieSecret: "s".repeat(64),
  measurementId: "G-TEST", apiSecret: "test" };
const trackingEvent = () => {
  const now = Date.now();
  return { event_id: crypto.randomUUID(), name: "generate_lead", client_id: "1.2", session_id: 123,
    session_started_ms: now, session_expires_ms: now + 1800000, timestamp_ms: now, consent: granted, params: {} };
};
const host = (region?: "eu") =>
  buildGoogleRequest({ measurementId: "G-TEST", apiSecret: "test", region }, trackingEvent(), granted)!.url.host;

it("Google host stays the default without GA4_REGION and moves to the EU endpoint with eu", () => {
  expect(configFromEnv(env).region).toBeUndefined();
  expect(configFromEnv({ ...env, GA4_REGION: "" }).region).toBeUndefined();
  expect(configFromEnv({ ...env, GA4_REGION: "eu" }).region).toBe("eu");
  expect(() => configFromEnv({ ...env, GA4_REGION: "us" })).toThrow("GA4_REGION");
  expect(host()).toBe("www.google-analytics.com");
  expect(host("eu")).toBe("region1.google-analytics.com");
});

it("the collector delivers to the configured EU endpoint", async () => {
  const google = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const app = createApp({ ...site, region: "eu" }, google);
  const response = await app.inject({ method: "POST", url: "/e", payload: trackingEvent(),
    headers: { origin: site.siteOrigin, "content-type": "application/json" } });
  expect(response.statusCode).toBe(204);
  expect(String(google.mock.calls[0]![0])).toMatch(/^https:\/\/region1\.google-analytics\.com\/mp\/collect\?/);
  await app.close();
});

it("self-declared automated clients match, ordinary browsers and Cubot phones do not", () => {
  for (const agent of [
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0) Chrome/130.0 Safari/537.36",
    "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
    "AdsBot-Google (+http://www.google.com/adsbot.html)",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Linux; Android 11) Chrome/130.0 Mobile Safari/537.36 Chrome-Lighthouse",
    "Mozilla/5.0 (compatible; Yahoo! Slurp; http://help.yahoo.com/help/us/ysearch/slurp)",
    "Bytespider", "curl/8.7.1", "python-requests/2.32.3", "Go-http-client/2.0",
  ]) expect(isObviousBot(agent), agent).toBe(true);
  for (const agent of [
    undefined, "",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0",
    "Mozilla/5.0 (Linux; Android 14; Pixel 9 Pro) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 10; CUBOT NOTE 20 Build/QP1A) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36",
  ]) expect(isObviousBot(agent), String(agent)).toBe(false);
});

it("an obvious bot is answered as delivered, counted, and reaches neither Google nor the cookie", async () => {
  const google = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const app = createApp(site, google);
  const send = (agent: string) => app.inject({ method: "POST", url: "/e", payload: trackingEvent(),
    headers: { origin: site.siteOrigin, "content-type": "application/json", "user-agent": agent } });
  const bot = await send("Mozilla/5.0 (compatible; Googlebot/2.1)");
  expect(bot.statusCode).toBe(204);
  expect(bot.headers["set-cookie"]).toBeUndefined();
  expect(google).not.toHaveBeenCalled();
  expect((await app.inject("/health")).json().google.botsFiltered).toBe(1);
  const person = await send("Mozilla/5.0 Chrome/130.0 Safari/537.36");
  expect(person.statusCode).toBe(204);
  expect(person.headers["set-cookie"]).toBeDefined();
  expect(google).toHaveBeenCalledTimes(1);
  await app.close();
});
