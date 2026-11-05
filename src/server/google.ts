import { validateParams, validEventName } from "./mp-validation.js";
/** All Google wire-format decisions live here. Measurement Protocol only. */
import {
  intersect,
  canTrack,
  normalizeConsent,
  redactAds,
  type Consent,
} from "../shared/consent.js";
import { timely, type TrackingEvent } from "../shared/event.js";
export interface Destination {
  measurementId: string;
  apiSecret: string;
  region?: "eu";
}
export type Delivery = "sent" | "retry" | "dropped";
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
  const params = validateParams({
    ...(redactAds(event.params) as Record<string, unknown>),
    session_id: event.session_id,
  });
  const host =
    destination.region === "eu" ? "region1.google-analytics.com" : "www.google-analytics.com";
  const url = new URL(`https://${host}/mp/collect`);
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
      events: [
        ...(event.campaign
          ? [
              {
                name: "campaign_details",
                params: validateParams({ ...event.campaign, session_id: event.session_id }),
              },
            ]
          : []),
        { name: event.name, params },
      ],
    },
  };
}
export async function sendGoogle(
  destination: Destination,
  event: TrackingEvent,
  getCurrent: () => Consent,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<Delivery> {
  const request = buildGoogleRequest(destination, event, getCurrent());
  if (!request || signal.aborted) return "dropped";
  try {
    const response = await fetcher(request.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request.body),
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
