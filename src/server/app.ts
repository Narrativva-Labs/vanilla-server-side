import { validEventName } from "./mp-validation.js";
import { COOKIE_NAME, cookieHeader, serverIdentity, type CookieConfig } from "./identity.js";
import { isObviousBot } from "./bots.js";
import { createRateLimit } from "./rate-limit.js";
import Fastify from "fastify";
import { readFile } from "node:fs/promises";
import { consentSnapshot, canTrack, clickConsent, jsonSnapshot } from "../shared/consent.js";
import { DEFAULT_EVENTS } from "../shared/settings.js";
import { timely, type TrackingEvent } from "../shared/event.js";
import { sendGoogle, sendDeniedPing, type DeniedPing, type Destination } from "./google.js";
/** Oldest entries go first, so no map of visitor state can outgrow its limit. */
export function remember<T>(map: Map<string, T>, key: string, value: T, limit = 10000) {
  if (map.size >= limit && !map.has(key)) map.delete(map.keys().next().value!);
  map.set(key, value);
}
export function createApp(
  config: Destination & CookieConfig & { allowedEvents?: string[]; deniedPings?: boolean },
  fetcher: typeof fetch = fetch,
) {
  const app = Fastify({
    logger: false,
    // Production uses exactly one private Caddy hop; never expose the tracker port.
    trustProxy:
      process.env.NODE_ENV === "production" ? (_address: string, hop: number) => hop === 0 : false,
    bodyLimit: 32 * 1024,
    requestTimeout: 10000,
  });
  const allowed = new Set(config.allowedEvents ?? DEFAULT_EVENTS.split(","));
  const pings = config.deniedPings !== false;
  const limiter = createRateLimit();
  // Longer than the bounded Google request timeout; never retain visitor data in logs.
  const revoked = new Map<string, number>();
  const revoke = (key: string) => remember(revoked, key, Date.now() + 60000);
  const isRevoked = (key: string) => (revoked.get(key) ?? 0) > Date.now();
  const seen = new Map<string, number>();
  const inFlight = new Map<string, Promise<"sent" | "retry" | "dropped">>();
  const activeBrowsers = new Map<string, number>();
  const initialIdentities = new Map<
    string,
    { expires: number; identity: ReturnType<typeof serverIdentity> }
  >();
  // Sessions being opened right now, so a parallel event does not open the same one again.
  const opening = new Set<string>();
  let pruned = 0;
  const prune = () => {
    if (Date.now() - pruned < 1000) return;
    pruned = Date.now();
    for (const [key, expires] of revoked) if (expires <= Date.now()) revoked.delete(key);
    for (const [id, expires] of seen) if (expires <= Date.now()) seen.delete(id);
    for (const [key, expires] of activeBrowsers)
      if (expires <= Date.now()) activeBrowsers.delete(key);
    for (const [key, value] of initialIdentities)
      if (value.expires <= Date.now()) initialIdentities.delete(key);
  };
  const timer = setInterval(prune, 60_000);
  timer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    seen.clear();
    inFlight.clear();
    revoked.clear();
    activeBrowsers.clear();
    initialIdentities.clear();
    opening.clear();
    limiter.clear();
  });
  const status = { sent: 0, errors: 0, botsFiltered: 0, lastSuccess: null as string | null };
  app.get("/health", async () => ({ ok: true, google: status }));
  // The tracker never changes while the process runs, so public requests do not touch the disk.
  const tracker = readFile(new URL("../public/s.js", import.meta.url), "utf8");
  tracker.catch(() => {});
  app.get("/s.js", async (_, reply) => {
    const source = await tracker;
    return reply
      .type("text/javascript")
      .header("Cache-Control", "public, max-age=300")
      .send(
        `document.currentScript.dataset.events=${JSON.stringify([...allowed].join(","))};document.currentScript.dataset.pings=${JSON.stringify(pings ? "on" : "off")};\n${source}`,
      );
  });
  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "OPTIONS" && req.headers.origin === config.siteOrigin) {
      return reply
        .header("Access-Control-Allow-Origin", config.siteOrigin)
        .header("Access-Control-Allow-Credentials", "true")
        .header("Vary", "Origin")
        .header("Access-Control-Allow-Methods", "POST")
        .header("Access-Control-Allow-Headers", "Content-Type")
        .code(204)
        .send();
    }
    if (req.method !== "POST") return;
    reply.header("Cache-Control", "no-store");
    if (
      req.headers.origin !== config.siteOrigin ||
      !req.headers["content-type"]?.startsWith("application/json")
    ) {
      return reply.code(403).send({ error: "origin_or_content_type" });
    }
    reply
      .header("Access-Control-Allow-Origin", config.siteOrigin)
      .header("Access-Control-Allow-Credentials", "true")
      .header("Vary", "Origin");
  });
  app.post<{ Body: { client_id?: string } }>("/p", async (req, reply) => {
    // Withdrawal calls no one and is never rate limited: the cookie must always go.
    prune();
    if (req.headers.cookie?.includes(`${COOKIE_NAME}=`))
      revoke("server:" + serverIdentity(config, req.headers.cookie).clientId);
    if (
      typeof req.body?.client_id === "string" &&
      /^\d{1,20}\.\d{1,20}$/.test(req.body.client_id) &&
      activeBrowsers.has(req.body.client_id)
    )
      revoke("browser:" + req.body.client_id);
    reply.header("Set-Cookie", cookieHeader(config, "", true));
    return reply.code(204).send();
  });
  app.post<{ Body: DeniedPing }>(
    "/d",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["consent", "page_location"],
          properties: {
            consent: { type: "object" },
            page_location: { type: "string", maxLength: 2048 },
            page_referrer: { type: "string", maxLength: 2048 },
            page_title: { type: "string", maxLength: 1024 },
            language: { type: "string", maxLength: 32 },
            screen_resolution: { type: "string", pattern: "^[0-9]{1,6}x[0-9]{1,6}$" },
          },
        },
      },
    },
    async (req, reply) => {
      if (!pings) return reply.code(204).send();
      if (isObviousBot(req.headers["user-agent"])) {
        status.botsFiltered++;
        return reply.code(204).send();
      }
      const ping = { ...req.body, consent: consentSnapshot(req.body.consent) };
      if (ping.consent.analytics_storage !== "denied")
        return reply.code(400).send({ error: "ping_requires_denied_consent" });
      const release = limiter.claim(req.ip);
      if (!release) return reply.code(429).send({ error: "rate_limit" });
      try {
        // No cookie, no IP and no retry: this request leaves nothing that links two pings.
        const result = await sendDeniedPing(config, ping, req.headers["user-agent"], fetcher);
        if (result === "sent") status.sent++;
        else status.errors++;
        return reply.code(204).send();
      } finally {
        release();
      }
    },
  );
  app.post<{ Body: TrackingEvent }>(
    "/e",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: [
            "event_id",
            "name",
            "client_id",
            "session_id",
            "session_started_ms",
            "session_expires_ms",
            "timestamp_ms",
            "consent",
            "params",
          ],
          properties: {
            event_id: { type: "string", format: "uuid" },
            name: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9_]{0,39}$" },
            client_id: {
              type: "string",
              pattern: "^[0-9]{1,20}\\.[0-9]{1,20}$",
            },
            session_id: { type: "integer", minimum: 1 },
            session_started_ms: { type: "integer", minimum: 1 },
            session_expires_ms: { type: "integer", minimum: 1 },
            timestamp_ms: { type: "integer", minimum: 1 },
            consent: { type: "object" },
            params: { type: "object", maxProperties: 100 },
            device: {
              type: "object",
              additionalProperties: false,
              properties: {
                browser: { type: "string", maxLength: 100 },
                model: { type: "string", maxLength: 100 },
                category: { type: "string", maxLength: 32 },
                language: { type: "string", maxLength: 32 },
                screen_resolution: { type: "string", pattern: "^[0-9]{1,6}x[0-9]{1,6}$" },
              },
            },
            click_ids: {
              type: "object",
              additionalProperties: false,
              properties: {
                gclid: { type: "string", pattern: "^[A-Za-z0-9_-]{1,256}$" },
                gbraid: { type: "string", pattern: "^[A-Za-z0-9_-]{1,256}$" },
                wbraid: { type: "string", pattern: "^[A-Za-z0-9_-]{1,256}$" },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      // Answer as delivered so a bot has no reason to retry; it receives no cookie either.
      if (isObviousBot(req.headers["user-agent"])) {
        status.botsFiltered++;
        return reply.code(204).send();
      }
      const event = req.body;
      event.consent = consentSnapshot(event.consent);
      if (!canTrack(event.consent))
        return reply.code(403).send({ error: "analytics_consent_required" });
      if (
        !validEventName(event.name) ||
        (!allowed.has(event.name) && !["page_view", "page_engagement"].includes(event.name))
      )
        return reply.code(400).send({ error: "event_not_allowed" });
      if (!timely(event)) return reply.code(400).send({ error: "expired_event" });
      try {
        event.params = jsonSnapshot(event.params);
      } catch {
        return reply.code(400).send({ error: "invalid_event_data" });
      }
      const release = limiter.claim(req.ip);
      if (!release) return reply.code(429).send({ error: "rate_limit" });
      try {
        prune();
        if (seen.has(event.event_id)) return reply.code(204).send();
        const browserKey = "browser:" + event.client_id;
        remember(activeBrowsers, event.client_id, Date.now() + 60 * 60 * 1000);
        const pending = inFlight.get(event.event_id);
        if (pending) {
          const result = await pending;
          return result === "retry" ? reply.code(503).send() : reply.code(204).send();
        }
        const hasCookie = req.headers.cookie?.includes(`${COOKIE_NAME}=`) ?? false;
        const earlier = hasCookie ? undefined : initialIdentities.get(browserKey)?.identity;
        const identity = earlier ?? serverIdentity(config, req.headers.cookie);
        if (!hasCookie)
          remember(initialIdentities, browserKey, { identity, expires: Date.now() + 60_000 });
        if (isRevoked("server:" + identity.clientId) || isRevoked(browserKey))
          return reply.code(204).send();
        event.client_id = identity.clientId;
        event.session_id = identity.sessionId;
        event.session_started_ms = Math.min(identity.started, event.timestamp_ms);
        event.session_expires_ms = event.timestamp_ms + 30 * 60 * 1000;
        event.ip_override = req.ip;
        const clicked =
          event.name === "page_view" && event.click_ids && clickConsent(event.consent);
        const withdrawn = () => isRevoked("server:" + identity.clientId) || isRevoked(browserKey);
        // Fastify appends Set-Cookie, and an opened session sets it before the final answer.
        const keepCookie = () => {
          if (!withdrawn() && !reply.hasHeader("set-cookie"))
            reply.header("Set-Cookie", identity.cookie);
        };
        const starting = identity.newSession && !opening.has(identity.clientId);
        if (starting) opening.add(identity.clientId);
        const delivery = sendGoogle(
          config,
          event,
          () => (withdrawn() ? consentSnapshot(null) : event.consent),
          new AbortController().signal,
          fetcher,
          starting || clicked
            ? {
                sessionStart: starting,
                firstVisit: starting && identity.newClient,
                userAgent: req.headers["user-agent"],
                opened() {
                  // A browser that keeps no cookie must not open a new session with every event.
                  identity.newSession = identity.newClient = false;
                  keepCookie();
                },
              }
            : undefined,
        );
        inFlight.set(event.event_id, delivery);
        let result: "sent" | "retry" | "dropped";
        try {
          result = await delivery;
        } finally {
          inFlight.delete(event.event_id);
          if (starting) opening.delete(identity.clientId);
        }
        if (result !== "retry") remember(seen, event.event_id, Date.now() + 60_000);
        if (result === "sent") {
          status.sent++;
          status.lastSuccess = new Date().toISOString();
          identity.newSession = identity.newClient = false;
          keepCookie();
        } else {
          status.errors++;
          console.error("Google delivery failed", { outcome: result });
        }
        if (result === "retry") {
          seen.delete(event.event_id);
          return reply.code(503).send();
        }
        return reply.code(204).send();
      } finally {
        release();
      }
    },
  );
  return app;
}
