import { consentSnapshot } from "../../shared/consent.js";
import { categories, type CmpAdapter } from "./types.js";
type Host = EventTarget & {
  Cookiebot?: {
    hasResponse?: boolean;
    consent?: { statistics?: boolean; marketing?: boolean };
  };
};
export function cookiebot(host: Host): CmpAdapter {
  return {
    read() {
      const c = host.Cookiebot?.consent;
      if (host.Cookiebot && host.Cookiebot.hasResponse !== true) return consentSnapshot(null);
      return c ? categories(c.statistics === true, c.marketing === true) : undefined;
    },
    subscribe(change) {
      const events = ["CookiebotOnConsentReady", "CookiebotOnAccept", "CookiebotOnDecline"];
      events.forEach((e) => host.addEventListener(e, change));
      return () => events.forEach((e) => host.removeEventListener(e, change));
    },
  };
}
