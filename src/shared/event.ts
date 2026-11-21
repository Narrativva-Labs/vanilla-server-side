import type { Consent } from "./consent.js";
// A session ends after 30 idle minutes and has no maximum length, like the Google tag's
// (captured 2026-11-14: a session started 25 and 49 hours earlier kept its ID and count).
export const SESSION_MS = 30 * 60 * 1000;
export const MAX_EVENT_AGE_MS = 72 * 60 * 60 * 1000;
// Historical validator measurement: the validation server allows 256 UTF-8 bytes for these fields.
export const PAGE_TEXT_BYTES = 256;
const encoder = new TextEncoder();
/** Whole characters only, and never a dangling percent escape at the end of a URL. */
export function shortenBytes(value: string, limit: number) {
  if (encoder.encode(value).byteLength <= limit) return value;
  let bytes = 0;
  let output = "";
  for (const character of value) {
    bytes += encoder.encode(character).byteLength;
    if (bytes > limit) break;
    output += character;
  }
  return output.replace(/%[0-9a-f]?$/i, "");
}
export interface TrackingEvent {
  /** Independent bearer secret for consented, pre-cookie continuity; never sent to Google. */
  bootstrap_token?: string;
  page_id?: string;
  hit_index?: number;
  event_id: string;
  name: string;
  client_id: string;
  session_id: number;
  session_started_ms: number;
  session_expires_ms: number;
  timestamp_ms: number;
  consent: Consent;
  device?: {
    browser?: string;
    model?: string;
    category?: string;
    language?: string;
    screen_resolution?: string;
  };
  click_ids?: Record<string, string>;
  ip_override?: string;
  params: Record<string, unknown>;
}
export function timely(event: TrackingEvent, now = Date.now()) {
  return (
    event.timestamp_ms <= now + 5000 &&
    now - event.timestamp_ms <= MAX_EVENT_AGE_MS &&
    event.timestamp_ms >= event.session_started_ms &&
    event.timestamp_ms <= event.session_expires_ms &&
    event.session_expires_ms <= event.timestamp_ms + SESSION_MS
  );
}
