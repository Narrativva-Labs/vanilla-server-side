import { consentSnapshot, purposes, type Consent } from "../shared/consent.js";
import { isObject, toCommandArray } from "./data-layer.js";

type Values = Record<string, unknown>;
export type ConsentSignal =
  | { kind: "default" | "update"; settings: Values }
  | { kind: "banner"; read: unknown }
  | { kind: "refusal-handled" };
export const noConsent = {
  defaults: {} as Values,
  regional: {} as Values,
  banner: {} as Values,
  updates: {} as Values,
  lastRead: undefined as Consent | undefined,
  refusal: false,
};
export type ConsentState = typeof noConsent;
/** Priority rises from left to right, purpose by purpose. */
export const effectiveConsent = (state: ConsentState) =>
  consentSnapshot({ ...state.defaults, ...state.regional, ...state.banner, ...state.updates });
function layer(state: ConsentState, name: "defaults" | "regional" | "updates", settings: Values) {
  const named = purposes.filter((key) => Object.hasOwn(settings, key));
  // The script cannot know the visitor's region, so a regional default stays unresolved.
  const values = named.map((key) => [key, name === "regional" ? "unknown" : settings[key]]);
  return { ...state, [name]: { ...state[name], ...Object.fromEntries(values) } };
}
function readBanner(state: ConsentState, value: unknown): ConsentState {
  if (value === undefined) return { ...state, banner: {} };
  const read = consentSnapshot(value);
  const analytics = read.analytics_storage;
  const updates = { ...state.updates };
  // The first read reports a stored state. A later change is a new decision for those keys.
  for (const key of purposes)
    if (state.lastRead && read[key] !== "unknown" && read[key] !== state.lastRead[key])
      delete updates[key];
  // A denied read counts once. An undecided one cancels the denied update CookieYes sends on load.
  const refused = analytics === "denied" && state.banner.analytics_storage !== "denied";
  const refusal = refused || (state.refusal && analytics !== "unknown");
  const banner = Object.fromEntries(Object.entries(read).filter(([, v]) => v !== "unknown"));
  return { ...state, banner, updates, lastRead: read, refusal };
}
/** A refusal or grant by the visitor, not a starting value. */
export function decidedAnalytics(state: ConsentState) {
  const value = effectiveConsent(state).analytics_storage;
  if (value === "unknown") return false;
  if (value === "granted") return true;
  // A banner on screen and still undecided outweighs a denied update sent at load.
  if (state.lastRead?.analytics_storage === "unknown") return false;
  return (
    Object.hasOwn(state.banner, "analytics_storage") ||
    Object.hasOwn(state.updates, "analytics_storage")
  );
}
/** The whole consent logic, without DOM or clock. docs/technical-overview.md lists its rules. */
export function nextConsent(state: ConsentState, signal: ConsentSignal): ConsentState {
  if (signal.kind === "refusal-handled") return { ...state, refusal: false };
  if (signal.kind === "banner") return readBanner(state, signal.read);
  const { kind, settings } = signal;
  if (kind === "default")
    return layer(state, "region" in settings ? "regional" : "defaults", settings);
  const refusal = state.refusal || settings.analytics_storage === "denied";
  return { ...layer(state, "updates", settings), refusal };
}

export function createConsentObserver() {
  let state = noConsent;
  let waitUntil = 0;
  const apply = (signal: ConsentSignal) => void (state = nextConsent(state, signal));
  return {
    /** `refresh` runs first, so a banner change made before this command counts as older. */
    observe(item: unknown, refresh?: () => void) {
      const [name, kind, settings] = toCommandArray(item) ?? [];
      const known = name === "consent" && (kind === "default" || kind === "update");
      if (!known || !isObject(settings)) return false;
      refresh?.();
      apply({ kind, settings });
      const wait = settings.wait_for_update;
      if (kind === "update") waitUntil = 0;
      else if (typeof wait === "number" && Number.isFinite(wait))
        waitUntil = Date.now() + Math.min(2000, Math.max(0, wait));
      return true;
    },
    fallback: (read: unknown) => apply({ kind: "banner", read }),
    takeAnalyticsDenialUpdate() {
      const { refusal } = state;
      apply({ kind: "refusal-handled" });
      return refusal;
    },
    waitMs: () => Math.max(0, waitUntil - Date.now()),
    snapshot: () => effectiveConsent(state),
    /** False while analytics rests on a default alone or a supported banner still waits for a click. */
    decided: () => decidedAnalytics(state),
  };
}
