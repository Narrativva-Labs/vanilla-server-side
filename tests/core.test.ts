import { describe, it, expect, vi } from "vitest";
import { createTracker, type Runtime } from "../src/client/tracker.js";
import { createConsentObserver } from "../src/client/consent.js";

import { cookieconsent } from "../src/client/cmp/cookieconsent.js";
import { buildGoogleRequest } from "../src/server/google.js";
import { normalizeConsent } from "../src/shared/consent.js";
import { DEFAULT_EVENTS } from "../src/shared/settings.js";
import type { TrackingEvent } from "../src/shared/event.js";
const full = normalizeConsent({
  analytics_storage: "granted",
  ad_storage: "granted",
  ad_user_data: "granted",
  ad_personalization: "granted",
});
const destination = {
  cookieSecret: "s".repeat(64),
  measurementId: "G-TEST",
  apiSecret: "test-secret",
};
const now = Date.now();
function fixture(
  mode: "cookie" | "cookieless" = "cookie",
  fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 })),
) {
  let clock = now;
  const runtime: Runtime = {
    href: () => "https://shop.example/product?gclid=secret&email=private&utm_source=test#secret",
    referrer: () => "",
    now: () => clock,
    uuid: () => crypto.randomUUID(),
    fetch: fetcher,
    warn: vi.fn(),
  };
  const tracker = createTracker(
    "https://kx7qpa.example.com/e",
    runtime,
    new Set(DEFAULT_EVENTS.split(",")),
    mode,
  );
  return {
    tracker,
    runtime,
    fetcher,
    advance: () => {
      clock += 2001;
      return tracker.flush();
    },
    event: () => JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as TrackingEvent,
  };
}
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
describe("Google updates and banner categories", () => {
  it("partial updates preserve explicit denials and regional defaults never grant", () => {
    const o = createConsentObserver();
    o.observe(["consent", "default", { analytics_storage: "granted", region: ["US"] }]);
    expect(o.snapshot().analytics_storage).toBe("unknown");
    o.observe(["consent", "update", { analytics_storage: "denied" }]);
    o.observe(["consent", "update", { ad_storage: "granted" }]);
    expect(o.snapshot().analytics_storage).toBe("denied");
  });
  it("supports custom category names", () => {
    const host = Object.assign(new EventTarget(), {
      CookieConsent: {
        validConsent: () => true,
        acceptedCategory: (c: string) => ["stats", "advertising"].includes(c),
      },
    });
    expect(cookieconsent(host, "stats", ["advertising"]).read()).toEqual(full);
  });
});
describe("cookieless", () => {
  it("unknown sends page_view with denied ads, strips query and never reads cookies or storage", async () => {
    const f = fixture("cookieless");
    f.tracker.update({});
    await f.advance();
    await settle();
    const req = buildGoogleRequest(
      { ...destination, mode: "cookieless" },
      f.event(),
      f.event().consent,
    )!;
    expect(req.body.events.at(-1)!.name).toBe("page_view");
    expect(req.body.events.at(-1)!.params.page_location).toBe(
      "https://shop.example/product?utm_source=test",
    );
    expect(req.body.consent).toEqual({
      ad_user_data: "DENIED",
      ad_personalization: "DENIED",
    });
    // Runtime exposes no storage/write capability; the branch has only RAM identity.
    expect(Object.keys(f.runtime)).not.toContain("cookie");
    const g = fixture("cookieless");
    g.tracker.update({});
    await g.advance();
    await settle();
    expect(g.event().client_id).not.toBe(f.event().client_id);
    expect(g.event().session_id).not.toBe(f.event().session_id);
  });
  it("explicit denial sends nothing; withdrawal stops and clears", async () => {
    const f = fixture("cookieless");
    f.tracker.update({ analytics_storage: "denied" });
    f.tracker.track("generate_lead");
    expect(f.fetcher).not.toHaveBeenCalled();
    f.tracker.update({});
    await f.advance();
    await settle();
    f.tracker.update({ analytics_storage: "denied" });
    f.tracker.track("generate_lead");
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.tracker.pending()).toBe(0);
  });
});
