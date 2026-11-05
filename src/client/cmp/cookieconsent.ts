import { consentSnapshot } from "../../shared/consent.js";
import { categories, type CmpAdapter } from "./types.js";
type Host = EventTarget & {
  CookieConsent?: {
    validConsent?(): boolean;
    acceptedCategory(name: string): boolean;
  };
};
export function cookieconsent(
  host: Host,
  analytics = "analytics",
  marketing = ["ads", "marketing"],
): CmpAdapter {
  return {
    read() {
      const cmp = host.CookieConsent;
      if (!cmp || typeof cmp.acceptedCategory !== "function") return;
      if (cmp.validConsent?.() !== true) return consentSnapshot(null);
      return categories(
        cmp.acceptedCategory(analytics) === true,
        marketing.some((c) => cmp.acceptedCategory(c) === true),
      );
    },
    subscribe(change) {
      const events = ["cc:onConsent", "cc:onChange"];
      events.forEach((e) => host.addEventListener(e, change));
      return () => events.forEach((e) => host.removeEventListener(e, change));
    },
  };
}
