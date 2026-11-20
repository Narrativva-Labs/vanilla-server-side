import type { AgentFields } from "./agent-verification.js";
import { withLabels, type LabelMemory, type LabelObserver } from "./labels.js";
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
import { ENGAGED_MS } from "./identity.js";
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
  /** The session is engaged, from the signed cookie; see `engage`. */
  engaged?: boolean;
  userAgent?: string;
  /** The session is open at Google: a retry of this event must not open it again. */
  opened?(): void;
}
export interface DeniedPing {
  consent: Consent;
  name: string;
  params: Record<string, unknown>;
  client_id: string;
  session_id: number;
  page_id: string;
  hit_index: number;
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
  engaged?: boolean;
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
    // Without session state, the rule of `engage` for this hit alone.
    seg:
      (hit.engaged ??
      (!hit.sessionStart && (hit.name === "page_view" || Number(hit.engagement) > ENGAGED_MS)))
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
  agentFields?: AgentFields,
  labelMemory?: LabelMemory,
  observeLabels?: LabelObserver,
) {
  const consent = intersect(normalizeConsent(event.consent), normalizeConsent(current));
  if (!canTrack(consent) || !timely(event)) return undefined;
  if (!validEventName(event.name)) {
    console.warn("Event dropped: invalid or reserved name");
    return undefined;
  }
  // URLs are cleaned here too: a request does not have to come from the tracker.
  const cleaned = cleanUrls(redactAds(event.params)) as Record<string, unknown>;
  const params = validateParams(
    withLabels(
      { ...cleaned, session_id: event.session_id },
      agentFields,
      labelMemory
        ? {
            memory: labelMemory,
            key: JSON.stringify(["session", event.client_id, event.session_id]),
          }
        : undefined,
      observeLabels,
    ),
  );
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
    engaged: opening?.engaged,
  });
  appendParams(url, params);
  return url;
}
function appendParams(url: URL, params: Record<string, unknown>) {
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
}
/** Fields the Google tag moves into the POST body once the URL grows long. */
const bodyField = (key: string) =>
  key === "en" || key === "_et" || /^epn?\./.test(key) || /^pr\d+$/.test(key);
/** Google answers 413 to a larger body (measured 2026-11-10); the URL does not count. */
const COLLECT_BODY_BYTES = 16 * 1024;
/**
 * Like the Google tag, a URL over 2000 bytes keeps the shared fields in the query and sends
 * the event, its parameters and items as a one-line body. Google rejects a body over 16 KiB
 * (about 130 items), where the Google tag loses the whole purchase; here the last items are
 * left out instead, so revenue, transaction ID and the conversion still arrive.
 */
export function collectRequest(
  url: URL,
  _agentFields = false,
): { url: URL; body?: string } | undefined {
  if (Buffer.byteLength(url.href) <= 2000) return { url };
  const head = new URL(url.origin + url.pathname);
  const parts: { key: string; text: string }[] = [];
  for (const [key, value] of url.searchParams)
    if (bodyField(key)) parts.push({ key, text: new URLSearchParams([[key, value]]).toString() });
    else head.searchParams.append(key, value);
  let size = parts.reduce((n, part) => n + Buffer.byteLength(part.text) + 1, -1);
  // Optional labels must never turn an otherwise deliverable event into an oversized hit.
  for (const name of ["ep.vv_detail", "ep.vv_type"]) {
    if (size <= COLLECT_BODY_BYTES) break;
    const index = parts.findIndex((part) => part.key === name);
    if (index < 0) continue;
    size -= Buffer.byteLength(parts[index]!.text) + 1;
    parts.splice(index, 1);
  }
  let left = 0;
  for (let i = parts.length - 1; i >= 0 && size > COLLECT_BODY_BYTES; i--) {
    if (!/^pr\d+$/.test(parts[i]!.key)) continue;
    size -= Buffer.byteLength(parts[i]!.text) + 1;
    parts.splice(i, 1);
    left++;
  }
  if (size > COLLECT_BODY_BYTES) {
    console.warn("Collect event dropped: encoded event exceeds 16 KiB without items");
    return undefined;
  }
  if (left) console.warn(`Collect event trimmed: ${left} items left out to fit 16 KiB`);
  return { url: head, body: parts.map((part) => part.text).join("&") };
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
/** Preview sticky labels while encoding; commit only labels present in a deliverable hit. */
function stageLabels(memory?: LabelMemory, observe?: LabelObserver) {
  let pending: Parameters<LabelObserver> | undefined;
  let saved: { key: string; labels: Parameters<LabelObserver>[0] } | undefined;
  return {
    memory: memory && {
      ...memory,
      apply(key: string, labels: Parameters<LabelObserver>[0]) {
        saved = { key, labels };
        return memory.apply(key, labels, false);
      },
    },
    observe: (...args: Parameters<LabelObserver>) => {
      pending = args;
    },
    commit(request: { url: URL; body?: string }) {
      const fields = new URLSearchParams(request.body ?? request.url.search);
      if (!fields.has("ep.vv_type") || !pending) return;
      if (saved) memory?.apply(saved.key, saved.labels);
      observe?.(...pending);
    },
  };
}
export async function sendGoogle(
  destination: Destination,
  event: TrackingEvent,
  getCurrent: () => Consent,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  opening?: Opening,
  verification?: Promise<AgentFields | undefined>,
  labelMemory?: LabelMemory,
  observeLabels?: LabelObserver,
): Promise<Delivery> {
  const agentFields = verification ? await verification : undefined;
  const staged = stageLabels(labelMemory, observeLabels);
  const url = buildEventCollectUrl(
    destination,
    event,
    getCurrent(),
    opening,
    agentFields,
    staged.memory,
    staged.observe,
  );
  const request = url && collectRequest(url, agentFields !== undefined);
  if (!request || signal.aborted) return "dropped";
  staged.commit(request);
  const delivery = await post(
    request.url,
    { headers: browser(opening?.userAgent), body: request.body },
    signal,
    fetcher,
  );
  if (delivery === "sent") opening?.opened?.();
  return delivery;
}
/** Cookieless page identity, visitor IP and event parameters; no click IDs or retries. */
export async function sendDeniedPing(
  destination: Destination,
  ping: DeniedPing,
  userAgent?: string,
  fetcher: typeof fetch = fetch,
  ip?: string,
  verification?: Promise<AgentFields | undefined>,
  labelMemory?: LabelMemory,
  observeLabels?: LabelObserver,
) {
  const agentFields = verification ? await verification : undefined;
  const staged = stageLabels(labelMemory, observeLabels);
  function strip(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key.toLowerCase() !== "user_data")
          .map(([key, entry]) => [key, strip(entry)]),
      );
    return value;
  }
  const cleaned = cleanUrls(redactAds(strip(ping.params))) as Record<string, unknown>;
  const params = validateParams(
    withLabels(
      { ...cleaned, session_id: ping.session_id },
      agentFields,
      staged.memory
        ? { memory: staged.memory, key: JSON.stringify(["page", ping.page_id]) }
        : undefined,
      staged.observe,
    ),
  );
  const first = ping.hit_index === 1;
  const url = buildCollectUrl(destination, {
    name: ping.name,
    clientId: ping.client_id,
    sessionId: ping.session_id,
    pageId: ping.page_id,
    hitIndex: ping.hit_index,
    consent: normalizeConsent(ping.consent),
    location: cleaned.page_location,
    referrer: cleaned.page_referrer,
    title: cleaned.page_title,
    language: ping.language,
    screen: ping.screen_resolution,
    ip,
    engagement: params.engagement_time_msec,
    sessionStart: first,
    firstVisit: first,
    sessionCount: 1,
  });
  appendParams(url, params);
  const request = collectRequest(url, agentFields !== undefined);
  if (!request) return Promise.resolve<Delivery>("dropped");
  staged.commit(request);
  return post(
    request.url,
    { headers: browser(userAgent), body: request.body },
    new AbortController().signal,
    fetcher,
  );
}
