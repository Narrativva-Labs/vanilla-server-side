import { consentSnapshot } from "../../shared/consent.js";
import { categories, type CmpAdapter } from "./types.js";
type Host = EventTarget & {
  dataLayer?: unknown[];
  shoptet?: {
    consent?: {
      isSet?(): unknown;
      isAccepted?(name: string): unknown;
      onAccept?(listener: () => void): void;
    };
  };
};
type Choice = { event?: unknown; cookie_consent?: { analytics?: unknown; marketing?: unknown } };
/**
 * Documented dataLayer contract. Values start as denied, so a denied value only counts
 * as a refusal when it comes with the cookie_consent event sent after the visitor's choice.
 */
function fromDataLayer(layer: unknown[] | undefined) {
  const items = (Array.isArray(layer) ? layer : []) as (Choice | null)[];
  const item = [...items].reverse().find((entry) => entry?.cookie_consent);
  if (!item?.cookie_consent) return;
  const { analytics, marketing } = item.cookie_consent;
  if (analytics === "granted" || marketing === "granted" || item.event === "cookie_consent") {
    return categories(analytics === "granted", marketing === "granted");
  }
}
/** Anything unexpected means no answer, never a refusal. */
export function shoptet(host: Host): CmpAdapter {
  return {
    read() {
      try {
        const cmp = host.shoptet?.consent;
        // shoptet.consent is public template code and also recognises returning visitors.
        if (typeof cmp?.isSet !== "function") return fromDataLayer(host.dataLayer);
        // The dataLayer says denied before any choice, so only isSet() marks a decision.
        if (cmp.isSet() !== true) return consentSnapshot(null);
        const analytics = cmp.isAccepted?.("analytics");
        const marketing = cmp.isAccepted?.("personalisation");
        if (typeof analytics !== "boolean" || typeof marketing !== "boolean") return;
        return categories(analytics, marketing);
      } catch {
        return;
      }
    },
    subscribe(change) {
      // Listeners cannot be removed, and Shoptet may load later: polling covers both.
      try {
        host.shoptet?.consent?.onAccept?.(change);
      } catch {}
      return () => {};
    },
  };
}
