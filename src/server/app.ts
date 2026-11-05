import { validEventName } from "./mp-validation.js";
import { COOKIE_NAME, cookieHeader, serverIdentity, type CookieConfig } from "./identity.js";
import { isObviousBot } from "./bots.js";
import { createRateLimit } from "./rate-limit.js";
import Fastify from "fastify";
import { readFile } from "node:fs/promises";
import { consentSnapshot, canTrack, jsonSnapshot } from "../shared/consent.js";
import { DEFAULT_EVENTS } from "../shared/settings.js";
import { timely, type TrackingEvent } from "../shared/event.js";
import { sendGoogle, type Destination } from "./google.js";
export function createApp(
  config: Destination & CookieConfig & { allowedEvents?: string[] },
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
  const limiter = createRateLimit();
  // Longer than the bounded Google request timeout; never retain visitor data in logs.
  const revoked = new Map<string, number>();
  const revoke = (key: string) => {
    if (revoked.size >= 10000 && !revoked.has(key)) revoked.delete(revoked.keys().next().value!);
    revoked.set(key, Date.now() + 60000);
  };
  const isRevoked = (key: string) => (revoked.get(key) ?? 0) > Date.now();
  const seen = new Map<string, number>();
  const inFlight = new Map<string, Promise<"sent" | "retry" | "dropped">>();
  const activeBrowsers = new Map<string, number>();
  const initialIdentities = new Map<
    string,
    { expires: number; identity: ReturnType<typeof serverIdentity> }
  >();
  const prune = () => {
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
    limiter.clear();
  });
  const status = { sent: 0, errors: 0, botsFiltered: 0, lastSuccess: null as string | null };
  app.get("/health", async () => ({ ok: true, google: status }));
  app.get("/s.js", async (_, reply) => {
    const source = await readFile(new URL("../public/s.js", import.meta.url), "utf8");
    return reply
      .type("text/javascript")
      .header("Cache-Control", "public, max-age=300")
      .send(
        `document.currentScript.dataset.events=${JSON.stringify([...allowed].join(","))};document.currentScript.dataset.mode=${JSON.stringify(config.mode ?? "cookie")};\n${source}`,
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
    const release = limiter.claim(req.ip);
    if (!release) return reply.code(429).send({ error: "rate_limit" });
    try {
      if (config.mode !== "cookieless") {
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
      }
      return reply.code(204).send();
    } finally {
      release();
    }
  });
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
            campaign: {
              type: "object",
              maxProperties: 6,
              additionalProperties: { type: "string", maxLength: 100 },
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
      if (!canTrack(event.consent, config.mode ?? "cookie"))
        return reply.code(403).send({ error: "analytics_consent_required" });
      if (
        !validEventName(event.name) ||
        (!allowed.has(event.name) && !["page_view", "page_engagement"].includes(event.name))
      )
        return reply.code(400).send({ error: "event_not_allowed" });
      if (!timely(event, Date.now(), config.mode === "cookieless" ? undefined : Infinity))
        return reply.code(400).send({ error: "expired_event" });
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
        activeBrowsers.set(event.client_id, Date.now() + 60 * 60 * 1000);
        const pending = inFlight.get(event.event_id);
        if (pending) {
          const result = await pending;
          return result === "retry" ? reply.code(503).send() : reply.code(204).send();
        }
        let identity: ReturnType<typeof serverIdentity> | undefined;
        if (config.mode !== "cookieless") {
          const hasCookie = req.headers.cookie?.includes(`${COOKIE_NAME}=`) ?? false;
          if (!hasCookie) {
            const existing = initialIdentities.get(browserKey);
            identity = existing?.identity ?? serverIdentity(config, req.headers.cookie);
            initialIdentities.set(browserKey, { identity, expires: Date.now() + 60_000 });
          } else identity = serverIdentity(config, req.headers.cookie);
          if (isRevoked("server:" + identity.clientId) || isRevoked(browserKey))
            return reply.code(204).send();
          event.client_id = identity.clientId;
          event.session_id = identity.sessionId;
          event.session_started_ms = Math.min(identity.started, event.timestamp_ms);
          event.session_expires_ms = event.timestamp_ms + 30 * 60 * 1000;
          event.ip_override = req.ip;
          if (!identity.newSession) delete event.campaign;
        }
        const delivery = sendGoogle(
          config,
          event,
          () => event.consent,
          new AbortController().signal,
          fetcher,
        );
        inFlight.set(event.event_id, delivery);
        let result: "sent" | "retry" | "dropped";
        try {
          result = await delivery;
        } finally {
          inFlight.delete(event.event_id);
        }
        if (result !== "retry") {
          if (seen.size >= 10000) seen.delete(seen.keys().next().value!);
          seen.set(event.event_id, Date.now() + 60_000);
        }
        if (result === "sent") {
          status.sent++;
          status.lastSuccess = new Date().toISOString();
          if (identity && !isRevoked("server:" + identity.clientId) && !isRevoked(browserKey))
            reply.header("Set-Cookie", identity.cookie);
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
