import { describe, it, expect } from "vitest";
import { createConsentObserver } from "../src/client/consent.js";

import { cookieconsent } from "../src/client/cmp/cookieconsent.js";
import { normalizeConsent } from "../src/shared/consent.js";
const full = normalizeConsent({
  analytics_storage: "granted",
  ad_storage: "granted",
  ad_user_data: "granted",
  ad_personalization: "granted",
});
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
