/** All events use the Google tag wire format; see the protocol notes. */
import { randomInt } from "node:crypto";
import { validateParams, validEventName } from "./mp-validation.js";
import {
  intersect,
  canTrack,
  clickConsent,
  cleanUrls,
  normalizeConsent,
  redactAds,
  sanitizeUrl,
  type Consent,
} from "../shared/consent.js";
import { shortenBytes, timely, type TrackingEvent } from "../shared/event.js";
export interface Destination {
  measurementId: string;
  region?: "eu";
}
export type Delivery = "sent" | "retry" | "dropped";
/** Session flags and browser context for a collect hit. */
export interface Opening {
  sessionStart: boolean;
  firstVisit: boolean;
  /** Sessions of this visitor including the current one. */
  sessionCount?: number;
  userAgent?: string;
  /** The session is open at Google: a retry of this event must not open it again. */
  opened?(): void;
}
export interface DeniedPing {
  consent: Consent;
  page_location: string;
  page_referrer?: string;
  page_title?: string;
  language?: string;
  screen_resolution?: string;
}
interface CollectHit {
  pageId?: string;
  hitIndex?: number;
  name: string;
  clientId: string;
  sessionId: number;
  consent: Consent;
  location: unknown;
  referrer: unknown;
  title: unknown;
  language?: string;
  screen?: string;
  ip?: string;
  clicks?: Record<string, string>;
  engagement?: unknown;
  sessionStart: boolean;
  firstVisit: boolean;
  sessionCount?: number;
}
const COLLECT_URL_BYTES = 1000;
const COLLECT_TITLE_BYTES = 300;
const host = (destination: Destination) =>
  destination.region === "eu" ? "region1.google-analytics.com" : "www.google-analytics.com";
const text = (value: unknown) => (typeof value === "string" ? value : "");
function landingUrl(location: unknown, clicks?: Record<string, string>) {
  const clean = shortenBytes(sanitizeUrl(text(location)), COLLECT_URL_BYTES);
  if (!clicks) return clean;
  try {
    const url = new URL(clean);
    for (const [key, value] of Object.entries(clicks)) url.searchParams.set(key, value);
    return url.href;
  } catch {
    return clean;
  }
}
/** Field names and consent encoding follow captured Google tag hits, see the protocol notes. */
export function buildCollectUrl(destination: Destination, hit: CollectHit) {
  const { ad_storage, analytics_storage, ad_user_data, ad_personalization } = hit.consent;
  const bit = (value: string) => (value === "granted" ? "1" : "0");
  const mark = (value: string) => (value === "granted" ? "t" : "p");
  const fields: Record<string, string | undefined> = {
    v: "2",
    tid: destination.measurementId,
    _p: hit.pageId ?? String(randomInt(1, 2147483647)),
    gcs: `G1${bit(ad_storage)}${bit(analytics_storage)}`,
    gcd: `13${mark(ad_storage)}3${mark(analytics_storage)}3${mark(ad_user_data)}2${mark(ad_personalization)}5l1`,
    npa: ad_personalization === "granted" ? "0" : "1",
    cid: hit.clientId,
    sid: String(hit.sessionId),
    sct: hit.sessionCount ? String(hit.sessionCount) : undefined,
    seg:
      (hit.name === "page_view" && !hit.sessionStart) || Number(hit.engagement) >= 10000
        ? "1"
        : "0",
    _s: String(hit.hitIndex ?? 1),
    en: hit.name,
    dl: landingUrl(hit.location, hit.clicks),
    dr: shortenBytes(sanitizeUrl(text(hit.referrer)), COLLECT_URL_BYTES),
    dt: shortenBytes(redactAds(text(hit.title)) as string, COLLECT_TITLE_BYTES),
    ul: hit.language?.toLowerCase(),
    sr: hit.screen,
    _uip: hit.ip,
    _et:
      Number.isSafeInteger(hit.engagement) && Number(hit.engagement) > 0
        ? String(hit.engagement)
        : undefined,
    _ss: hit.sessionStart ? "1" : undefined,
    _fv: hit.firstVisit ? "1" : undefined,
    _nsi: hit.sessionStart ? "1" : undefined,
  };
  const url = new URL(`https://${host(destination)}/g/collect`);
  for (const [key, value] of Object.entries(fields)) if (value) url.searchParams.set(key, value);
  return url;
}
const itemFields: Record<string, string> = {
  item_id: "id",
  item_name: "nm",
  price: "pr",
  quantity: "qt",
  item_brand: "br",
  item_category: "ca",
  item_category2: "c2",
  item_category3: "c3",
  item_category4: "c4",
  item_category5: "c5",
  item_variant: "va",
  item_list_name: "ln",
  item_list_id: "li",
  index: "lp",
  affiliation: "af",
  coupon: "cp",
  discount: "ds",
  location_id: "lo",
  promotion_id: "pi",
  promotion_name: "pn",
  creative_name: "cn",
  creative_slot: "cs",
};
function itemValue(value: unknown) {
  // The Google tag doubles a literal tilde, so it cannot start another item field.
  return String(value).replaceAll("~", "~~");
}
function encodeItem(item: Record<string, unknown>) {
  const fields: string[] = [];
  let custom = 0;
  for (const [key, value] of Object.entries(item)) {
    const field = Object.hasOwn(itemFields, key) ? itemFields[key] : undefined;
    if (field) fields.push(field + itemValue(value));
    else {
      const index = custom < 10 ? String(custom) : String.fromCharCode(65 + custom - 10);
      fields.push(`k${index}${key}`, `v${index}${itemValue(value)}`);
      custom++;
    }
  }
  return fields.join("~");
}
export function buildEventCollectUrl(
  destination: Destination,
  event: TrackingEvent,
  current: Consent,
  opening?: Opening,
) {
  const consent = intersect(normalizeConsent(event.consent), normalizeConsent(current));
  if (!canTrack(consent) || !timely(event)) return undefined;
  if (!validEventName(event.name)) {
    console.warn("Event dropped: invalid or reserved name");
    return undefined;
  }
  // URLs are cleaned here too: a request does not have to come from the tracker.
  const cleaned = cleanUrls(redactAds(event.params)) as Record<string, unknown>;
  const params = validateParams({ ...cleaned, session_id: event.session_id });
  const url = buildCollectUrl(destination, {
    name: event.name,
    clientId: event.client_id,
    sessionId: event.session_id,
    consent,
    pageId: event.page_id,
    hitIndex: event.hit_index,
    // Collect keeps 1000 bytes of URL, so long campaign values survive on every hit.
    location: cleaned.page_location,
    referrer: cleaned.page_referrer,
    title: cleaned.page_title,
    language: event.device?.language,
    screen: event.device?.screen_resolution,
    ip: event.ip_override,
    clicks: event.name === "page_view" && clickConsent(consent) ? event.click_ids : undefined,
    engagement: params.engagement_time_msec,
    sessionStart: opening?.sessionStart ?? false,
    firstVisit: opening?.firstVisit ?? false,
    sessionCount: opening?.sessionCount,
  });
  for (const [key, value] of Object.entries(params)) {
    if (
      [
        "session_id",
        "page_location",
        "page_referrer",
        "page_title",
        "engagement_time_msec",
      ].includes(key)
    )
      continue;
    if (key === "items" && Array.isArray(value))
      value.forEach((item, i) => url.searchParams.set(`pr${i + 1}`, encodeItem(item)));
    else {
      // GA4 sums only numeric money fields, and sites often push them as text.
      const money =
        ["value", "tax", "shipping"].includes(key) && /^-?\d+(\.\d+)?$/.test(String(value));
      const numeric = typeof value === "number" || money;
      url.searchParams.set(
        key === "currency" ? "cu" : `${numeric ? "epn" : "ep"}.${key}`,
        String(value),
      );
    }
  }
  return url;
}
/** Fields the Google tag moves into the POST body once the URL grows long. */
const bodyField = (key: string) =>
  key === "en" || key === "_et" || /^epn?\./.test(key) || /^pr\d+$/.test(key);
const COLLECT_BODY_BYTES = 64 * 1024;
/**
 * Like the Google tag, a URL over 2000 bytes keeps the shared fields in the query and sends
 * the event, its parameters and items as a one-line body, so a large basket is not dropped.
 */
export function collectRequest(url: URL): { url: URL; body?: string } | undefined {
  if (Buffer.byteLength(url.href) <= 2000) return { url };
  const head = new URL(url.origin + url.pathname);
  const body = new URLSearchParams();
  for (const [key, value] of url.searchParams)
    (bodyField(key) ? body : head.searchParams).append(key, value);
  const text = body.toString();
  if (Buffer.byteLength(text) > COLLECT_BODY_BYTES) {
    console.warn("Collect event dropped: encoded event exceeds 64 KiB");
    return undefined;
  }
  return { url: head, body: text };
}
async function post(
  url: URL,
  init: RequestInit,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<Delivery> {
  try {
    const response = await fetcher(url, {
      method: "POST",
      ...init,
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    });
    if (response.ok) return "sent";
    return response.status === 429 || (response.status >= 500 && response.status < 600)
      ? "retry"
      : "dropped";
  } catch {
    return signal.aborted ? "dropped" : "retry";
  }
}
const browser = (userAgent?: string) => (userAgent ? { "user-agent": userAgent } : undefined);
export async function sendGoogle(
  destination: Destination,
  event: TrackingEvent,
  getCurrent: () => Consent,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  opening?: Opening,
): Promise<Delivery> {
  const url = buildEventCollectUrl(destination, event, getCurrent(), opening);
  const request = url && collectRequest(url);
  if (!request || signal.aborted) return "dropped";
  const delivery = await post(
    request.url,
    { headers: browser(opening?.userAgent), body: request.body },
    signal,
    fetcher,
  );
  if (delivery === "sent") opening?.opened?.();
  return delivery;
}
/** Advanced Consent Mode ping: a one-off ID, no visitor IP, no click IDs, no cookie. */
export function sendDeniedPing(
  destination: Destination,
  ping: DeniedPing,
  userAgent?: string,
  fetcher: typeof fetch = fetch,
) {
  const seconds = Math.floor(Date.now() / 1000);
  const url = buildCollectUrl(destination, {
    name: "page_view",
    clientId: `${randomInt(1, 2147483647)}.${seconds}`,
    sessionId: seconds,
    consent: normalizeConsent(ping.consent),
    location: ping.page_location,
    referrer: ping.page_referrer,
    title: ping.page_title,
    language: ping.language,
    screen: ping.screen_resolution,
    sessionStart: true,
    firstVisit: true,
    sessionCount: 1,
  });
  return post(url, { headers: browser(userAgent) }, new AbortController().signal, fetcher);
}
