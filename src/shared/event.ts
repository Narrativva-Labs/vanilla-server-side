import type { Consent } from "./consent.js";
export const SESSION_MS = 30 * 60 * 1000;
export const MAX_EVENT_AGE_MS = 72 * 60 * 60 * 1000;
// Measured with npm run verify:mp: the validation server allows 256 UTF-8 bytes for these fields.
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
