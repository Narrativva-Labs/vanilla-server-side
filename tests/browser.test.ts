import { it, expect } from "vitest";
import { page } from "./browser-fixture.js";
it("accepts gtag Arguments and preserves the original dataLayer", async () => {
  const p = page([["consent", "update", { analytics_storage: "granted" }]]);
  p.command("event", "generate_lead", { value: 10 });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(p.fetcher.mock.calls.map(([, o]) => JSON.parse(String(o?.body)).name)).toEqual([
    "page_view",
    "generate_lead",
  ]);
  expect(p.host.dataLayer).toHaveLength(2);
  expect(p.cookieReads()).toBe(0);
});
it("the browser entry reads and writes no storage and stops after a real denial", async () => {
  const p = page();
  p.command("consent", "update", { analytics_storage: "granted" });
  await Promise.resolve();
  expect(p.fetcher).toHaveBeenCalledTimes(1);
  expect(p.cookieReads()).toBe(0);
  p.command("consent", "update", { analytics_storage: "denied" });
  p.host.dataLayer.push({
    event: "purchase",
    ecommerce: { transaction_id: "one" },
  });
  expect(p.fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/e", "/p"]);
  expect(p.cookieReads()).toBe(0);
});
it("a historical consent sequence stops collection on denial", () => {
  const p = page([
    ["consent", "default", { analytics_storage: "granted" }],
    ["consent", "update", { analytics_storage: "denied" }],
  ]);
  expect(p.fetcher.mock.calls.every(([url]) => String(url).endsWith("/p"))).toBe(true);
  expect(p.cookieReads()).toBe(0);
});

it("default denied without a visitor decision sends zero requests, including after polling", async () => {
  const p = page([["consent", "default", { analytics_storage: "denied" }]]);
  p.command("event", "generate_lead");
  (p.host.setInterval.mock.calls[0]![0] as () => void)();
  p.host.dispatchEvent(new Event("pagehide"));
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(p.fetcher).toHaveBeenCalledTimes(0);
  expect(p.cookieReads()).toBe(0);
});
it("an explicit denied update after default denied deletes once without collecting", async () => {
  const p = page([["consent", "default", { analytics_storage: "denied" }]]);
  expect(p.fetcher).toHaveBeenCalledTimes(0);
  p.command("consent", "update", { analytics_storage: "denied" });
  (p.host.setInterval.mock.calls[0]![0] as () => void)();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(p.fetcher).toHaveBeenCalledTimes(1);
  expect(String(p.fetcher.mock.calls[0]![0])).toMatch(/\/p$/);
});
it("unknown consent sends no deletion request", async () => {
  const p = page();
  (p.host.setInterval.mock.calls[0]![0] as () => void)();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(p.fetcher).toHaveBeenCalledTimes(0);
});
it("banner withdrawal still deletes the cookie after a fallback grant", async () => {
  const p = page();
  const banner = { hasResponse: true, consent: { statistics: true, marketing: false } };
  Object.assign(p.host, { Cookiebot: banner });
  p.host.dispatchEvent(new Event("CookiebotOnConsentReady"));
  for (let i = 0; i < 20; i++) await Promise.resolve();
  banner.consent.statistics = false;
  p.host.dispatchEvent(new Event("CookiebotOnDecline"));
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(p.fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/e", "/p"]);
});

for (const kind of ["Cookiebot", "CookieConsent"] as const) {
  for (const initial of ["unknown", "denied"] as const) {
    it(`${kind}: a resolved denial without a prior grant deletes once after ${initial} default`, async () => {
      const p = page(
        initial === "denied" ? [["consent", "default", { analytics_storage: "denied" }]] : [],
      );
      let decided = false;
      Object.assign(
        p.host,
        kind === "Cookiebot"
          ? {
              Cookiebot: {
                get hasResponse() {
                  return decided;
                },
                consent: { statistics: false, marketing: false },
              },
            }
          : {
              CookieConsent: { validConsent: () => decided, acceptedCategory: () => false },
            },
      );
      const notification = kind === "Cookiebot" ? "CookiebotOnDecline" : "cc:onConsent";
      p.host.dispatchEvent(new Event(notification));
      (p.host.setInterval.mock.calls[0]![0] as () => void)();
      expect(p.fetcher).toHaveBeenCalledTimes(0);
      decided = true;
      p.host.dispatchEvent(new Event(notification));
      (p.host.setInterval.mock.calls[0]![0] as () => void)();
      p.host.dispatchEvent(new Event(notification));
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(p.fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/p"]);
      expect(p.cookieReads()).toBe(0);
    });
  }
  it(`${kind}: the first read of a banner denial does not override an explicit Google grant`, async () => {
    const p = page([["consent", "update", { analytics_storage: "granted" }]]);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    Object.assign(
      p.host,
      kind === "Cookiebot"
        ? {
            Cookiebot: { hasResponse: true, consent: { statistics: false, marketing: false } },
          }
        : {
            CookieConsent: { validConsent: () => true, acceptedCategory: () => false },
          },
    );
    p.host.dispatchEvent(new Event(kind === "Cookiebot" ? "CookiebotOnDecline" : "cc:onConsent"));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(p.fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/e"]);
  });
}
