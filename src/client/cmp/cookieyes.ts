import { consentSnapshot } from "../../shared/consent.js";
import { categories, type CmpAdapter } from "./types.js";
type Host = EventTarget & {
  getCkyConsent?():
    | {
        isUserActionCompleted?: boolean;
        categories?: { analytics?: boolean; advertisement?: boolean };
      }
    | undefined;
};
export function cookieyes(host: Host, events: EventTarget): CmpAdapter {
  return {
    read() {
      if (typeof host.getCkyConsent !== "function") return;
      const consent = host.getCkyConsent();
      if (!consent) return;
      // The update event also fires on load listing every category as rejected,
      // so only this flag separates an undecided visitor from a refusal.
      if (consent.isUserActionCompleted !== true) return consentSnapshot(null);
      return categories(
        consent.categories?.analytics === true,
        consent.categories?.advertisement === true,
      );
    },
    subscribe(change) {
      const event = "cookieyes_consent_update";
      events.addEventListener(event, change);
      return () => events.removeEventListener(event, change);
    },
  };
}
