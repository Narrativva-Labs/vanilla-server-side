import { DEFAULT_EVENTS } from "../shared/settings.js";
export function configFromEnv(env = process.env) {
  const siteOrigin = new URL(env.SITE_ORIGIN ?? "http://localhost:3000").origin;
  const measurementId = env.GA4_MEASUREMENT_ID ?? "";
  const apiSecret = env.GA4_API_SECRET ?? "";
  if (
    !/^G-[A-Z0-9]+$/.test(measurementId) ||
    measurementId === "G-XXXXXXXXXX" ||
    !apiSecret ||
    apiSecret.startsWith("replace-")
  ) {
    throw new Error("Set GA4_MEASUREMENT_ID and GA4_API_SECRET");
  }
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT");
  const mode = env.TRACKING_MODE ?? "cookie";
  if (mode !== "cookie" && mode !== "cookieless")
    throw new Error("TRACKING_MODE must be cookie or cookieless");
  const cookieSecret = env.COOKIE_SECRET ?? "";
  if (
    mode === "cookie" &&
    (cookieSecret.length < 32 || cookieSecret.startsWith("replace-"))
  )
    throw new Error("COOKIE_SECRET must contain at least 32 characters");
  const cookieDomain = env.COOKIE_DOMAIN || new URL(siteOrigin).hostname.replace(/^www\./, "");
  if (!/^[a-z0-9.-]+$/i.test(cookieDomain)) throw new Error("Invalid COOKIE_DOMAIN");
  const allowedEvents = (env.TRACKED_EVENTS ?? DEFAULT_EVENTS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (
    !allowedEvents.length ||
    allowedEvents.some(
      (s) => !/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(s) || s === "page_view",
    )
  )
    throw new Error(
      "Invalid TRACKED_EVENTS (page_view is managed automatically)",
    );
  return {
    mode: mode as "cookie" | "cookieless",
    allowedEvents,
    cookieSecret,
    cookieDomain,
    siteOrigin,
    measurementId,
    apiSecret,
    port,
    host: env.HOST ?? "0.0.0.0",
  };
}
