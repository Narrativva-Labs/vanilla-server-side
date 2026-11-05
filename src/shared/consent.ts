export const purposes = [
  "analytics_storage",
  "ad_storage",
  "ad_user_data",
  "ad_personalization",
] as const;
export type Consent = Record<
  (typeof purposes)[number],
  "granted" | "denied" | "unknown"
>;
/** Missing, malformed and unknown values always deny. Each update is a full snapshot. */
export function normalizeConsent(value: unknown): Consent {
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    purposes.map((key) => [
      key,
      source[key] === "granted" ? "granted" : "denied",
    ]),
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
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    purposes.map((k) => [
      k,
      source[k] === "granted" || source[k] === "denied" ? source[k] : "unknown",
    ]),
  ) as Consent;
}
export function canTrack(consent: Consent, mode: "cookie" | "cookieless") {
  return mode === "cookieless"
    ? consent.analytics_storage !== "denied"
    : consent.analytics_storage === "granted";
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
    if (input.startsWith("//"))
      return `//${url.host}${url.pathname}${url.search}`;
    if (!/^https?:/i.test(input)) return `${url.pathname}${url.search}`;
    return url.href;
  } catch {
    return "";
  }
}
export function analyticsOnly(value: unknown, key = ""): unknown {
  if (Array.isArray(value))
    return value.map((entry) => analyticsOnly(entry, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([name]) =>
            !/^(user_id|user_data|user_agent|ip|ip_address|ip_override|client_id)$/i.test(
              name,
            ),
        )
        .map(([name, entry]) => [name, analyticsOnly(entry, name)]),
    );
  }
  const isUrlField = /(?:^|_)(url|location|referrer)$/i.test(key);
  const isAbsoluteUrl =
    typeof value === "string" && /^https?:\/\//i.test(value.trim());
  return typeof value === "string" && (isUrlField || isAbsoluteUrl)
    ? sanitizeUrl(value)
    : value;
}
/** Reject cycles, unsupported JSON values and excessive nesting before recursive filters. */
export function jsonSnapshot<T>(value: T): T {
  const ancestors = new Set<object>();
  function visit(entry: unknown, depth: number) {
    if (depth > 30 || typeof entry === "bigint")
      throw new Error("Unsupported event data");
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
    .replace(
      /([?&#])([^?&#=]+)=([^&#]*)/g,
      (all, separator: string, key: string) => {
        try {
          return adKey.test(decodeURIComponent(key)) ? separator : all;
        } catch {
          return separator;
        }
      },
    )
    .replace(/([?&#])&+/g, "$1")
    .replace(/[?&]+(?=#|$)/g, "");
}
