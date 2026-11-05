import { consentSnapshot, purposes, type Consent } from "../shared/consent.js";
import { isObject, toCommandArray } from "./data-layer.js";

export function createConsentObserver() {
  const defaults: Record<string, unknown> = {};
  const updates: Record<string, unknown> = {};
  const regional = new Set<string>();
  let fallback: unknown;
  let lastRead: Consent | undefined;
  let waitUntil = 0;
  let analyticsDenialUpdate = false;

  return {
    /** `refresh` runs first, so a banner change made before this command counts as older. */
    observe(item: unknown, refresh?: () => void) {
      const command = toCommandArray(item);
      const isConsent = command?.[0] === "consent";
      const isDefault = command?.[1] === "default";
      const isUpdate = command?.[1] === "update";
      if (!isConsent || !(isDefault || isUpdate) || !isObject(command[2])) return false;
      refresh?.();
      const settings = command[2];
      if (isUpdate && settings.analytics_storage === "denied") analyticsDenialUpdate = true;
      if (isUpdate) waitUntil = 0;
      if (
        isDefault &&
        typeof settings.wait_for_update === "number" &&
        Number.isFinite(settings.wait_for_update)
      ) {
        waitUntil = Date.now() + Math.min(2000, Math.max(0, settings.wait_for_update));
      }
      for (const key of purposes) {
        if (!Object.hasOwn(settings, key)) continue;
        if (isDefault && "region" in settings) regional.add(key);
        else (isUpdate ? updates : defaults)[key] = settings[key];
      }
      return true;
    },
    fallback(value: unknown) {
      const read = consentSnapshot(value);
      const analytics = read.analytics_storage;
      // CookieYes pushes a denied update on load: an undecided adapter means nobody refused yet.
      // A later refusal still deletes through the transition below.
      if (value !== undefined && analytics === "unknown") analyticsDenialUpdate = false;
      // Adapters return denied only for a resolved visitor decision, never a default.
      // Consume this transition once so polling does not repeat cookie deletion.
      if (analytics === "denied" && consentSnapshot(fallback).analytics_storage !== "denied")
        analyticsDenialUpdate = true;
      // The first read only reports a stored state. A later change is a new decision, so it
      // replaces older Google updates for those keys; a newer update replaces it in turn.
      if (value !== undefined) {
        for (const key of purposes)
          if (lastRead && read[key] !== "unknown" && read[key] !== lastRead[key])
            delete updates[key];
        lastRead = read;
      }
      fallback = value;
    },
    takeAnalyticsDenialUpdate() {
      const pending = analyticsDenialUpdate;
      analyticsDenialUpdate = false;
      return pending;
    },
    waitMs() {
      return Math.max(0, waitUntil - Date.now());
    },
    snapshot(): Consent {
      const unresolved = Object.fromEntries([...regional].map((key) => [key, "unknown"]));
      // An undecided banner adds nothing; a decided one outranks every kind of default.
      const banner = Object.fromEntries(
        Object.entries(consentSnapshot(fallback)).filter(([, state]) => state !== "unknown"),
      );
      return consentSnapshot({
        ...defaults,
        ...unresolved,
        ...banner,
        ...updates,
      });
    },
  };
}
