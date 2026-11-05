import type { Consent } from "./consent.js";
export const SESSION_MS = 30 * 60 * 1000;
export const MAX_EVENT_AGE_MS = 72 * 60 * 60 * 1000;
export interface TrackingEvent {
  event_id: string;
  name: string;
  client_id: string;
  session_id: number;
  session_started_ms: number;
  session_expires_ms: number;
  timestamp_ms: number;
  consent: Consent;
  device?: { browser?: string; model?: string; category?: string; language?: string; screen_resolution?: string };
  campaign?: Record<string, string>;
  ip_override?: string;
  params: Record<string, unknown>;
}
export function timely(event: TrackingEvent, now = Date.now(), maxSessionAgeMs = 24 * 60 * 60 * 1000) {
  return (
    event.timestamp_ms <= now + 5000 &&
    now - event.timestamp_ms <= MAX_EVENT_AGE_MS &&
    event.timestamp_ms >= event.session_started_ms &&
    event.timestamp_ms <= event.session_expires_ms &&
    event.session_expires_ms <= event.timestamp_ms + SESSION_MS &&
    now - event.session_started_ms <= maxSessionAgeMs
  );
}
