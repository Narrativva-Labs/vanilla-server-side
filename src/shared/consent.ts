export const purposes = [
  "analytics_storage",
  "ad_storage",
  "ad_user_data",
  "ad_personalization",
] as const;
export type Consent = Record<(typeof purposes)[number], "granted" | "denied" | "unknown">;
/** Missing, malformed and unknown values always deny. For the three-state view see consentSnapshot. */
export function normalizeConsent(value: unknown): Consent {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(
    purposes.map((key) => [key, source[key] === "granted" ? "granted" : "denied"]),
  ) as Consent;
}
export function intersect(a: Consent, b: Consent): Consent {
  return Object.fromEntries(
    purposes.map((key) => [
      key,
      a[key] === "granted" && b[key] === "granted" ? "granted" : "denied",
    ]),
  ) as Consent;
}
export function consentSnapshot(value: unknown): Consent {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(
    purposes.map((k) => [
      k,
      source[k] === "granted" || source[k] === "denied" ? source[k] : "unknown",
    ]),
  ) as Consent;
}
export function canTrack(consent: Consent) {
  return consent.analytics_storage === "granted";
}
export function sanitizeUrl(value: string) {
  try {
    const input = value
      .trim()
      .replace(/\\/g, "/")
      .replace(/^(https?):(?!\/\/)/i, "$1://");
    // An empty referrer means there is none; resolving it would invent the path "/".
    if (!input) return "";
    const url = new URL(input, "https://relative.invalid/");
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.hash = "";
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (!key.startsWith("utm_")) url.searchParams.delete(key);
    }
    if (input.startsWith("//")) return `//${url.host}${url.pathname}${url.search}`;
    if (!/^https?:/i.test(input)) return `${url.pathname}${url.search}`;
    return url.href;
  } catch {
    return "";
  }
}
/** Clean URL fields and absolute URLs at any depth. Plain text in a URL field has nothing to remove. */
export function cleanUrls(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((entry) => cleanUrls(entry, key));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [name, cleanUrls(entry, name)]),
    );
  if (typeof value !== "string") return value;
  const isUrlField = /(?:^|_)(url|location|referrer)$/i.test(key) && /[/\\?#]/.test(value);
  return isUrlField || /^https?:\/\//i.test(value.trim()) ? sanitizeUrl(value) : value;
}
/** Reject cycles, unsupported JSON values and excessive nesting before recursive filters. */
export function jsonSnapshot<T>(value: T): T {
  const ancestors = new Set<object>();
  function visit(entry: unknown, depth: number) {
    if (depth > 30 || typeof entry === "bigint") throw new Error("Unsupported event data");
    if (!entry || typeof entry !== "object") return;
    if (ancestors.has(entry)) throw new Error("Cyclic event data");
    ancestors.add(entry);
    for (const child of Object.values(entry)) visit(child, depth + 1);
    ancestors.delete(entry);
  }
  visit(value, 0);
  return JSON.parse(JSON.stringify(value)) as T;
}
const adKey =
  /(?:^|[._])(gclid|gbraid|wbraid|dclid|gclsrc|gad_source|gad_campaignid|fbclid|msclkid|gcl_aw|gcl_dc|gcl_gb|gcl_gs)$/i;
/** Recursively redact keys AND URL strings, including nested stored landing pages. */
export function redactAds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAds);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !adKey.test(key))
        .map(([key, v]) => [key, redactAds(v)]),
    );
  if (typeof value !== "string") return value;
  // Handle absolute and relative URLs; strip query IDs including in fragment routes.
  return value
    .replace(/([?&#])([^?&#=]+)=([^&#]*)/g, (all, separator: string, key: string) => {
      try {
        return adKey.test(decodeURIComponent(key)) ? separator : all;
      } catch {
        return separator;
      }
    })
    .replace(/([?&#])&+/g, "$1")
    .replace(/[?&]+(?=#|$)/g, "");
}
