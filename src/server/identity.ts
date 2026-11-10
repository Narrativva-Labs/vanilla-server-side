import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { SESSION_LIMIT_MS, SESSION_MS } from "../shared/event.js";
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
  const sign = (value: string) =>
    createHmac("sha256", config.cookieSecret).update(value).digest("base64url");
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
    const expected = Buffer.from(sign(payload), "base64url");
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
          (parsed.count === undefined || (Number.isSafeInteger(parsed.count) && parsed.count > 0))
        )
          state = parsed;
      } catch {
        /* Invalid cookies start a fresh identity. */
      }
    }
    if (state) break;
  }
  const newClient = !state;
  const newSession =
    !state || now - state.last >= SESSION_MS || now - state.started >= SESSION_LIMIT_MS;
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
  }
  state.last = now;
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  return {
    ...state,
    count: state.count ?? 1,
    newClient,
    newSession,
    cookie: cookieHeader(config, `${payload}.${sign(payload)}`),
  };
}
