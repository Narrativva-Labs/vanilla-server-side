import { afterEach, expect, it, vi } from "vitest";
import { validateParams, validEventName } from "../src/server/mp-validation.js";
import { buildGoogleRequest, sendGoogle } from "../src/server/google.js";
import { deviceModel, deviceBrowser } from "../src/client/device.js";
import { normalizeConsent } from "../src/shared/consent.js";
import { page } from "./browser-fixture.js";
const destination = { measurementId: "G-TEST", apiSecret: "test" };
const granted = normalizeConsent({ analytics_storage: "granted" });
const event = () => {
  const now = Date.now();
  return { event_id: crypto.randomUUID(), name: "page_engagement", client_id: "1.2",
    session_id: 123, session_started_ms: now, session_expires_ms: now + 1800000,
    timestamp_ms: now, consent: granted, params: {} };
};
afterEach(() => vi.useRealTimers());
it("final automatic parameters take precedence, strings obey standard-property limits", () => {
  const warn = vi.fn();
  const params = validateParams({ ...Object.fromEntries(Array.from({ length: 26 }, (_, i) => ["field_" + i, i])),
    session_id: 123, engagement_time_msec: 1200, page_location: "x".repeat(200),
    page_referrer: "r".repeat(200), page_title: "😀".repeat(101) }, warn);
  expect(Object.keys(params)).toHaveLength(25);
  expect(params).toMatchObject({ session_id: 123, engagement_time_msec: 1200,
    page_location: "x".repeat(100), page_referrer: "r".repeat(100), page_title: "😀".repeat(100) });
  expect(warn).toHaveBeenCalled();
  const invalid = validateParams({ "bad-name": "x", ["n".repeat(41)]: "x", _private: 1,
    firebase_conversion: 1, google_value: 1, ga_value: 1, firebase_value: 1,
    long: "x".repeat(101), nested: { x: 1 }, valid: "x".repeat(100) }, warn);
  expect(invalid).toEqual({ valid: "x".repeat(100) });
});
it("ecommerce items retain standard fields plus 27 custom parameters", () => {
  const custom = Object.fromEntries(Array.from({ length: 28 }, (_, i) => [`custom_${i}`, i]));
  const params = validateParams({ items: [{ item_id: "sku", item_name: "Boot", price: 10, quantity: 2, ...custom }] });
  const item = (params.items as Record<string, unknown>[])[0]!;
  expect(item).toMatchObject({ item_id: "sku", item_name: "Boot", price: 10, quantity: 2 });
  expect(Object.keys(item).filter(key => key.startsWith("custom_"))).toHaveLength(27);
});
it("reserved events are rejected; custom page engagement and measured time are valid", () => {
  expect(validEventName("user_engagement")).toBe(false);
  expect(validEventName("session_start")).toBe(false);
  const e = { ...event(), params: { engagement_time_msec: 1200, session_id: 999 } };
  const request = buildGoogleRequest(destination, e, granted)!;
  expect(request.body.events.at(-1)).toEqual({ name: "page_engagement", params: { session_id: 123, engagement_time_msec: 1200 } });
});
it("device model uses available browser hints with generic fallbacks", () => {
  expect(deviceModel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)")).toBe("iPhone");
  expect(deviceModel("Mozilla/5.0 (Linux; Android 14; Pixel 9 Pro Build/123)")).toBe("Pixel 9 Pro");
  expect(deviceModel("Mozilla/5.0 (Windows NT 10.0)")).toBe("Windows PC");
  expect(deviceModel("")).toBe("Desktop");
});
for (const [status, expected] of [[204, "sent"], [400, "dropped"], [401, "dropped"], [403, "dropped"], [404, "dropped"], [413, "dropped"], [429, "retry"], [500, "retry"], [503, "retry"]] as const) {
  it(`Google HTTP ${status} is ${expected}`, async () => {
    expect(await sendGoogle(destination, event(), () => granted, new AbortController().signal,
      vi.fn<typeof fetch>(async () => new Response(null, { status })))).toBe(expected);
  });
}
it("network and timeout failures remain retryable", async () => {
  for (const error of [new TypeError("offline"), new DOMException("timeout", "TimeoutError")]) {
    expect(await sendGoogle(destination, event(), () => granted, new AbortController().signal,
      vi.fn<typeof fetch>(async () => { throw error; }))).toBe("retry");
  }
});
it("keepalive byte guard counts UTF-8, not UTF-16 characters", async () => {
  const p = page("cookie", [["consent", "update", granted]]);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  p.command("event", "generate_lead", { note: "😀".repeat(9000) });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(p.fetcher).toHaveBeenCalledTimes(1);
  expect(p.warnings).toHaveBeenCalledWith(expect.stringContaining("UTF-8"));
});
it("wait_for_update excludes pre-permission visible time", async () => {
  vi.useFakeTimers();
  const p = page("cookie", [["consent", "default", { ...granted, wait_for_update: 1000 }]]);
  vi.advanceTimersByTime(1000);
  (p.host.setInterval.mock.calls[0]![0] as () => void)();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const first = JSON.parse(String(p.fetcher.mock.calls[0]![1]?.body));
  expect(first.params.engagement_time_msec).toBe(0);
  vi.advanceTimersByTime(250);
  p.host.dispatchEvent(new Event("pagehide"));
  const exit = JSON.parse(String(p.fetcher.mock.calls.at(-1)![1]?.body));
  expect(exit.name).toBe("page_engagement");
  expect(exit.params.engagement_time_msec).toBe(250);
});

it("browser family detection distinguishes shared engine signatures and provides a fallback", () => {
  for (const [agent, browser] of [
    ["Mozilla/5.0 Chrome/130.0 Safari/537.36 Edg/130.0", "Edge"],
    ["Mozilla/5.0 Chrome/130.0 Safari/537.36 OPR/115.0", "Opera"],
    ["Mozilla/5.0 SamsungBrowser/26.0 Chrome/130.0 Safari/537.36", "Samsung Internet"],
    ["Mozilla/5.0 Firefox/130.0", "Firefox"],
    ["Mozilla/5.0 Chrome/130.0 Safari/537.36", "Chrome"],
    ["Mozilla/5.0 Version/18.0 Safari/605.1", "Safari"],
    ["Mozilla/5.0 CriOS/130.0 Mobile Safari/604.1", "Chrome"],
    ["Mozilla/5.0 FxiOS/130.0 Mobile Safari/605.1", "Firefox"],
    ["Mozilla/5.0 EdgiOS/130.0 Mobile Safari/605.1", "Edge"],
    ["", "Unknown"],
    ["unrecognized browser", "Unknown"],
  ]) expect(deviceBrowser(agent!)).toBe(browser);
});
it("MP always includes browser when device is present, with a fallback for missing or blank values", () => {
  for (const browser of [undefined, "", "   ", "Firefox"]) {
    const request = buildGoogleRequest(destination, { ...event(), device: { browser, model: "Desktop" } }, granted)!;
    expect(request.body.device?.browser).toBe(browser === "Firefox" ? "Firefox" : "Unknown");
  }
  expect(buildGoogleRequest(destination, event(), granted)!.body).not.toHaveProperty("device");
});
it("browser entry sends a detected browser family in its device object", async () => {
  const p = page("cookie", [["consent", "update", granted]]);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(JSON.parse(String(p.fetcher.mock.calls[0]![1]?.body)).device.browser).toBe("Unknown");
  p.host.navigator.userAgent = "Mozilla/5.0 Chrome/130.0 Safari/537.36";
  p.command("event", "generate_lead");
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(JSON.parse(String(p.fetcher.mock.calls.at(-1)![1]?.body)).device.browser).toBe("Chrome");
});
