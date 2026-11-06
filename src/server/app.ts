import { validEventName } from "./mp-validation.js";
import { COOKIE_NAME, cookieHeader, serverIdentity, type CookieConfig } from "./identity.js";
import { isObviousBot } from "./bots.js";
import { createRateLimit } from "./rate-limit.js";
import Fastify from "fastify";
import { readFile } from "node:fs/promises";
import { consentSnapshot, canTrack, clickConsent, jsonSnapshot } from "../shared/consent.js";
import { DEFAULT_EVENTS } from "../shared/settings.js";
import { SESSION_LIMIT_MS, timely, type TrackingEvent } from "../shared/event.js";
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
  const initialIdentities = new Map<
    string,
    { expires: number; identity: ReturnType<typeof serverIdentity> }
  >();
  // Sessions being opened right now. A parallel event waits for the result instead of
  // opening the session again or confirming one that has not opened.
  const opening = new Map<string, Promise<ReturnType<typeof serverIdentity> | undefined>>();
  // Sessions opened in the last minute, for a request that left with the older cookie.
  const recent = new Map<
    string,
    { expires: number; identity: ReturnType<typeof serverIdentity> }
  >();
  let pruned = 0;
  const prune = () => {
    if (Date.now() - pruned < 1000) return;
    pruned = Date.now();
    for (const [key, expires] of revoked) if (expires <= Date.now()) revoked.delete(key);
    for (const [id, expires] of seen) if (expires <= Date.now()) seen.delete(id);
    for (const map of [initialIdentities, recent])
      for (const [key, value] of map) if (value.expires <= Date.now()) map.delete(key);
  };
  const timer = setInterval(() => {
    prune();
    limiter.sweep();
  }, 60_000);
  timer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    seen.clear();
    inFlight.clear();
    revoked.clear();
    initialIdentities.clear();
    opening.clear();
    recent.clear();
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
    // Stored even for an unknown ID: the event it stops may still be on its way.
    if (typeof req.body?.client_id === "string" && /^\d{1,20}\.\d{1,20}$/.test(req.body.client_id))
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
        // Not async: a twin must not slip in between this check and the inFlight entry below.
        const duplicate = () => {
          if (seen.has(event.event_id)) return reply.code(204).send();
          return inFlight
            .get(event.event_id)
            ?.then((result) => reply.code(result === "retry" ? 503 : 204).send());
        };
        const answered = duplicate();
        if (answered) return await answered;
        const hasCookie = req.headers.cookie?.includes(`${COOKIE_NAME}=`) ?? false;
        const remembered = hasCookie ? undefined : initialIdentities.get(browserKey)?.identity;
        const earlier =
          remembered && Date.now() - remembered.started < SESSION_LIMIT_MS ? remembered : undefined;
        let identity = earlier ?? serverIdentity(config, req.headers.cookie);
        if (!hasCookie)
          remember(initialIdentities, browserKey, { identity, expires: Date.now() + 60_000 });
        if (isRevoked("server:" + identity.clientId) || isRevoked(browserKey))
          return reply.code(204).send();
        const clicked =
          event.name === "page_view" && event.click_ids && clickConsent(event.consent);
        const withdrawn = () => isRevoked("server:" + identity.clientId) || isRevoked(browserKey);
        const fresh = identity.newSession ? recent.get(identity.clientId) : undefined;
        if (fresh && fresh.expires > Date.now()) identity = fresh.identity;
        // One wait only, so a Google outage cannot hold this request and its rate limit slot.
        const running = identity.newSession ? opening.get(identity.clientId) : undefined;
        if (running) {
          // The opener's session, whose ID can differ from the one worked out for this request.
          identity = (await running) ?? identity;
          const answeredMeanwhile = duplicate();
          if (answeredMeanwhile) return await answeredMeanwhile;
        }
        // Nothing goes out in a session that is not open: the tracker retries this event.
        if (identity.newSession && opening.has(identity.clientId)) return reply.code(503).send();
        event.client_id = identity.clientId;
        event.session_id = identity.sessionId;
        event.session_started_ms = Math.min(identity.started, event.timestamp_ms);
        event.session_expires_ms = event.timestamp_ms + 30 * 60 * 1000;
        event.ip_override = req.ip;
        const starting = identity.newSession;
        let opened = false;
        let finishOpening = (_identity?: typeof identity) => {};
        if (starting)
          opening.set(
            identity.clientId,
            new Promise((resolve) => {
              finishOpening = resolve;
            }),
          );
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
                  if (!starting) return;
                  opened = true;
                  // A browser that keeps no cookie must not open a new session with every event.
                  identity.newSession = identity.newClient = false;
                  remember(recent, identity.clientId, { identity, expires: Date.now() + 60_000 });
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
          if (starting) {
            opening.delete(identity.clientId);
            finishOpening(opened ? identity : undefined);
          }
        }
        // Decided here, last, so a withdrawal during delivery always wins.
        if ((opened || (result === "sent" && !identity.newSession)) && !withdrawn())
          reply.header("Set-Cookie", identity.cookie);
        if (result !== "retry") remember(seen, event.event_id, Date.now() + 60_000);
        if (result === "sent") {
          status.sent++;
          status.lastSuccess = new Date().toISOString();
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
