/**
 * All Google wire-format decisions live here. /g/collect opens a session, because Measurement
 * Protocol alone gave no session source and no new users in tests, and it is what carries click
 * IDs. Measurement Protocol carries the rest, because it is documented and it can be validated.
 */
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
  apiSecret: string;
  region?: "eu";
}
export type Delivery = "sent" | "retry" | "dropped";
/** Set when this event must go through /g/collect. */
export interface Opening {
  sessionStart: boolean;
  firstVisit: boolean;
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
    _p: String(randomInt(1, 2147483647)),
    gcs: `G1${bit(ad_storage)}${bit(analytics_storage)}`,
    gcd: `13${mark(ad_storage)}3${mark(analytics_storage)}3${mark(ad_user_data)}2${mark(ad_personalization)}5l1`,
    npa: ad_personalization === "granted" ? "0" : "1",
    cid: hit.clientId,
    sid: String(hit.sessionId),
    seg: "0",
    _s: "1",
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
  };
  const url = new URL(`https://${host(destination)}/g/collect`);
  for (const [key, value] of Object.entries(fields)) if (value) url.searchParams.set(key, value);
  return url;
}
export function buildGoogleRequest(
  destination: Destination,
  event: TrackingEvent,
  current: Consent,
) {
  const consent = intersect(normalizeConsent(event.consent), normalizeConsent(current));
  if (!canTrack(event.consent) || !canTrack(current) || !timely(event)) return undefined;
  if (!validEventName(event.name)) {
    console.warn("MP event dropped: invalid or reserved name");
    return undefined;
  }
  // Click IDs are not a documented MP attribution mechanism. Remove them even from URLs.
  // URLs are cleaned here too: a request does not have to come from the tracker.
  const params = validateParams({
    ...(cleanUrls(redactAds(event.params)) as Record<string, unknown>),
    session_id: event.session_id,
  });
  const url = new URL(`https://${host(destination)}/mp/collect`);
  url.searchParams.set("measurement_id", destination.measurementId);
  url.searchParams.set("api_secret", destination.apiSecret);
  return {
    url,
    body: {
      client_id: event.client_id,
      timestamp_micros: event.timestamp_ms * 1000,
      consent: {
        ad_user_data: consent.ad_user_data === "granted" ? "GRANTED" : "DENIED",
        ad_personalization: consent.ad_personalization === "granted" ? "GRANTED" : "DENIED",
      },
      ...(event.device
        ? {
            device: {
              ...event.device,
              browser: event.device.browser?.trim() || "Unknown",
              model: event.device.model || event.device.category || "Unknown",
            },
          }
        : {}),
      ...(consent.analytics_storage === "granted" && event.ip_override
        ? { ip_override: event.ip_override }
        : {}),
      events: [{ name: event.name, params }],
    },
  };
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
  const current = getCurrent();
  const request = buildGoogleRequest(destination, event, current);
  if (!request || signal.aborted) return "dropped";
  if (opening) {
    const consent = intersect(normalizeConsent(event.consent), normalizeConsent(current));
    const pageView = event.name === "page_view";
    // These two carry all their data in the hit. Any other event needs its own MP request.
    const complete = pageView || event.name === "page_engagement";
    const url = buildCollectUrl(destination, {
      name: pageView ? "page_view" : "page_engagement",
      clientId: event.client_id,
      sessionId: event.session_id,
      consent,
      location: event.params.page_location,
      referrer: event.params.page_referrer,
      title: event.params.page_title,
      language: event.device?.language,
      screen: event.device?.screen_resolution,
      ip: event.ip_override,
      clicks: pageView && clickConsent(consent) ? event.click_ids : undefined,
      engagement: complete ? event.params.engagement_time_msec : undefined,
      sessionStart: opening.sessionStart,
      firstVisit: opening.firstVisit,
    });
    const delivery = await post(url, { headers: browser(opening.userAgent) }, signal, fetcher);
    if (delivery === "sent") opening.opened?.();
    if (delivery !== "sent" || complete) return delivery;
    // Consent may have been withdrawn while the first request was on its way.
    if (!canTrack(getCurrent())) return "dropped";
  }
  return post(
    request.url,
    { headers: { "content-type": "application/json" }, body: JSON.stringify(request.body) },
    signal,
    fetcher,
  );
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
  });
  return post(url, { headers: browser(userAgent) }, new AbortController().signal, fetcher);
}
