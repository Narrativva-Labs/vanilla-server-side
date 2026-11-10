import { DEFAULT_EVENTS } from "../shared/settings.js";
export function configFromEnv(env = process.env) {
  const siteOrigin = new URL(env.SITE_ORIGIN ?? "http://localhost:3000").origin;
  const measurementId = env.GA4_MEASUREMENT_ID ?? "";
  if (env.GA4_API_SECRET) console.warn("GA4_API_SECRET is ignored; all events use /g/collect");
  if (!/^G-[A-Z0-9]+$/.test(measurementId) || measurementId === "G-XXXXXXXXXX") {
    throw new Error("Set GA4_MEASUREMENT_ID");
  }
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
  const region = env.GA4_REGION || undefined;
  if (region !== undefined && region !== "eu") throw new Error("GA4_REGION must be eu or unset");
  const deniedPings = env.DENIED_PINGS || "on";
  if (deniedPings !== "on" && deniedPings !== "off")
    throw new Error("DENIED_PINGS must be on or off");
  const logEvents = env.LOG_EVENTS || "off";
  if (logEvents !== "on" && logEvents !== "off") throw new Error("LOG_EVENTS must be on or off");
  const cookieSecret = env.COOKIE_SECRET ?? "";
  if (cookieSecret.length < 32 || cookieSecret.startsWith("replace-"))
    throw new Error("COOKIE_SECRET must contain at least 32 characters");
  const cookieDomain = env.COOKIE_DOMAIN || new URL(siteOrigin).hostname.replace(/^www\./, "");
  if (!/^[a-z0-9.-]+$/i.test(cookieDomain)) throw new Error("Invalid COOKIE_DOMAIN");
  const allowedEvents = (env.TRACKED_EVENTS ?? DEFAULT_EVENTS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (
    !allowedEvents.length ||
    allowedEvents.some((s) => !/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(s) || s === "page_view")
  )
    throw new Error("Invalid TRACKED_EVENTS (page_view is managed automatically)");
  return {
    region: region as "eu" | undefined,
    deniedPings: deniedPings === "on",
    logEvents: logEvents === "on",
    allowedEvents,
    cookieSecret,
    cookieDomain,
    siteOrigin,
    measurementId,
    port,
    host: env.HOST ?? "0.0.0.0",
  };
}
