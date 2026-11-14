import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { SESSION_MS } from "../shared/event.js";
export const COOKIE_NAME = "vanilla_session";
export interface CookieConfig {
  cookieSecret: string;
  cookieDomain?: string;
  siteOrigin: string;
}
interface State {
  clientId: string;
  sessionId: number;
  started: number;
  last: number;
  /** Sessions of this visitor so far, sent as the Google tag's session count. */
  count?: number;
  /** Engagement time summed over the hits of this session, until it is engaged. */
  engagedMs?: number;
  /** The session is engaged, like `$g1` in the Google tag's session cookie. */
  engaged?: boolean;
}
/** The Google tag's default `session_engaged_time`; a property can change it, this server cannot see that. */
export const ENGAGED_MS = 10_000;
function sign(config: CookieConfig, value: string) {
  return createHmac("sha256", config.cookieSecret).update(value).digest("base64url");
}
function seal(config: CookieConfig, state: State) {
  const { clientId, sessionId, started, last, count, engagedMs, engaged } = state;
  const payload = Buffer.from(
    JSON.stringify({ clientId, sessionId, started, last, count, engagedMs, engaged }),
  ).toString("base64url");
  return cookieHeader(config, `${payload}.${sign(config, payload)}`);
}
export function cookieHeader(
  config: Omit<CookieConfig, "cookieSecret">,
  value: string,
  clear = false,
) {
  const domain = config.cookieDomain ?? new URL(config.siteOrigin).hostname.replace(/^www\./, "");
  return `${COOKIE_NAME}=${value}; Path=/; Domain=${domain}; HttpOnly; Secure; SameSite=Lax; Max-Age=${clear ? 0 : 34560000}`;
}
export function serverIdentity(config: CookieConfig, header = "", now = Date.now()) {
  if (!config.cookieSecret || config.cookieSecret.length < 32)
    throw new Error("COOKIE_SECRET must contain at least 32 characters");
  // Another Vanilla server on a parent or sibling domain can send a cookie with the same name.
  // Use the first one this server signed, rather than starting a new identity on every request.
  const candidates = header
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.startsWith(COOKIE_NAME + "="))
    .map((s) => s.slice(COOKIE_NAME.length + 1));
  let state: State | undefined;
  for (const raw of candidates) {
    const [payload = "", signature = "", extra] = raw.split(".");
    const expected = Buffer.from(sign(config, payload), "base64url");
    const supplied = Buffer.from(signature, "base64url");
    if (
      extra === undefined &&
      /^[A-Za-z0-9_-]+$/.test(payload) &&
      /^[A-Za-z0-9_-]{43}$/.test(signature) &&
      supplied.length === expected.length &&
      timingSafeEqual(supplied, expected)
    ) {
      try {
        const parsed = JSON.parse(Buffer.from(payload!, "base64url").toString()) as State;
        if (
          /^\d+\.\d+$/.test(parsed.clientId) &&
          Number.isSafeInteger(parsed.sessionId) &&
          parsed.sessionId > 0 &&
          Number.isFinite(parsed.started) &&
          parsed.started <= now &&
          Number.isFinite(parsed.last) &&
          parsed.last <= now &&
          now - parsed.last < 34560000000 &&
          (parsed.count === undefined ||
            (Number.isSafeInteger(parsed.count) && parsed.count > 0)) &&
          (parsed.engagedMs === undefined ||
            (Number.isSafeInteger(parsed.engagedMs) && parsed.engagedMs >= 0)) &&
          (parsed.engaged === undefined || typeof parsed.engaged === "boolean")
        )
          state = parsed;
      } catch {
        /* Invalid cookies start a fresh identity. */
      }
    }
    if (state) break;
  }
  const newClient = !state;
  const newSession = !state || now - state.last >= SESSION_MS;
  state ??= {
    clientId: `${randomInt(1, 2147483647)}.${Math.floor(now / 1000)}`,
    sessionId: 0,
    started: now,
    last: now,
    count: 0,
  };
  if (newSession) {
    state.sessionId = Math.floor(now / 1000);
    state.started = now;
    // A cookie from before the count existed has had at least one session.
    state.count = (state.count ?? 1) + 1;
    state.engagedMs = undefined;
    state.engaged = undefined;
  }
  state.last = now;
  return { ...state, count: state.count ?? 1, newClient, newSession, cookie: seal(config, state) };
}
export type Identity = ReturnType<typeof serverIdentity>;
/**
 * The engaged-session flag `seg` of one hit, kept for the session in the signed cookie, as the
 * Google tag keeps it in its own (captured 2026-11-14, see the protocol notes). The hit that opens
 * a session is never engaged. After it, a page view or more than 10 s of engagement time summed
 * over the session engages it, whatever the event is called, and it stays engaged until it ends.
 */
export function engage(
  config: CookieConfig,
  identity: Identity,
  name: string,
  engagement: unknown,
  opening: boolean,
) {
  if (!identity.engaged) {
    const time =
      Number.isSafeInteger(engagement) && Number(engagement) > 0 ? Number(engagement) : 0;
    identity.engagedMs = Math.min((identity.engagedMs ?? 0) + time, Number.MAX_SAFE_INTEGER);
    if (!opening && (name === "page_view" || identity.engagedMs > ENGAGED_MS)) {
      identity.engaged = true;
      identity.engagedMs = undefined;
    }
    identity.cookie = seal(config, identity);
  }
  return !opening && identity.engaged === true;
}
