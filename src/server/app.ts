import { validateTrustProxy } from "./config.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { createAgentCounters } from "./agent-counters.js";
import { createLabelMemories } from "./labels.js";
import { createAgentLabeller, type AgentVerifierOptions } from "./agent-verification.js";
import { validEventName } from "./mp-validation.js";
import {
  COOKIE_NAME,
  cookieHeader,
  engage,
  serverIdentity,
  type CookieConfig,
} from "./identity.js";
import { isObviousBot } from "./bots.js";
import { createRateLimit } from "./rate-limit.js";
import Fastify from "fastify";
import { readFile } from "node:fs/promises";
import { consentSnapshot, canTrack, jsonSnapshot } from "../shared/consent.js";
import { DEFAULT_EVENTS } from "../shared/settings.js";
import { timely, type TrackingEvent } from "../shared/event.js";
import { sendGoogle, sendDeniedPing, type DeniedPing, type Destination } from "./google.js";
/** Oldest entries go first, so no map of visitor state can outgrow its limit. */
export function remember<T>(map: Map<string, T>, key: string, value: T, limit = 10000) {
  if (map.size >= limit && !map.has(key)) map.delete(map.keys().next().value!);
  map.set(key, value);
}
export function createApp(
  config: Destination &
    CookieConfig & {
      allowedEvents?: string[];
      deniedPings?: boolean;
      deniedPingIp?: "full" | "truncated" | "off";
      deniedPingUserAgent?: boolean;
      logEvents?: boolean;
      agentVerification?: boolean;
      trackerHost?: string;
      trustProxy?: string[] | false;
      healthToken?: string;
    },
  fetcher: typeof fetch = fetch,
  verifierOptions: AgentVerifierOptions = {},
) {
  if (
    config.healthToken !== undefined &&
    (!config.healthToken || config.healthToken.trim() !== config.healthToken)
  )
    throw new Error("Invalid HEALTH_TOKEN");
  const healthDigest =
    config.healthToken === undefined
      ? undefined
      : createHash("sha256").update(config.healthToken).digest();
  const app = Fastify({
    logger: false,
    // Caddy uses a private Compose peer. Public direct peers cannot supply forwarded identity.
    trustProxy:
      validateTrustProxy(config.trustProxy) ??
      (process.env.NODE_ENV === "production" ? ["loopback", "uniquelocal"] : false),
    // The browser keepalive limit. Google takes at most 16 KiB per hit; see collectRequest.
    bodyLimit: 64 * 1024,
    requestTimeout: 10000,
  });
  const labeller = config.agentVerification
    ? createAgentLabeller(config.trackerHost, verifierOptions)
    : undefined;
  const label = labeller?.label;
  const { sessions: labelMemory, pages: pageLabelMemory } = createLabelMemories();
  const agentCounters = createAgentCounters();
  const allowed = new Set(config.allowedEvents ?? DEFAULT_EVENTS.split(","));
  const pings = config.deniedPings !== false;
  // LOG_EVENTS=on: one line per event with its name, the answer and Google's outcome only.
  const outcomes = new WeakMap<object, string>();
  if (config.logEvents)
    app.addHook("onResponse", async (req, reply) => {
      if (req.routeOptions.url !== "/e") return;
      const name = (req.body as { name?: unknown } | undefined)?.name;
      const label = typeof name === "string" && validEventName(name) ? name : "?";
      console.info(`Event ${label} ${reply.statusCode} ${outcomes.get(req) ?? "-"}`);
    });
  const limiter = createRateLimit();
  // Longer than the bounded Google request timeout; never retain visitor data in logs.
  const revoked = new Map<string, number>();
  const revoke = (key: string) => remember(revoked, key, Date.now() + 60000);
  const isRevoked = (key: string) => (revoked.get(key) ?? 0) > Date.now();
  const seen = new Map<string, number>();
  const inFlight = new Map<string, Promise<"sent" | "retry" | "dropped">>();
  // Bootstrap continuity for concurrent first-visit hits before the signed cookie arrives.
  // Only possession of a separate random secret permits joining, never client_id alone.
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
    labelMemory.sweep();
    pageLabelMemory.sweep();
  }, 60_000);
  timer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    labeller?.close();
    labelMemory.clear();
    pageLabelMemory.clear();
    seen.clear();
    inFlight.clear();
    revoked.clear();
    initialIdentities.clear();
    opening.clear();
    recent.clear();
    limiter.clear();
  });
  const status = { sent: 0, errors: 0, botsFiltered: 0, lastSuccess: null as string | null };
  app.get("/health", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (healthDigest) reply.header("Vary", "X-Health-Token");
    const supplied = req.headers["x-health-token"];
    const authorized =
      !healthDigest ||
      (typeof supplied === "string" &&
        timingSafeEqual(createHash("sha256").update(supplied).digest(), healthDigest));
    return {
      ok: true,
      google: status,
      ...(authorized
        ? {
            agentVerification: {
              ...(labeller?.status() ?? {
                enabled: false,
                directoriesLoaded: "0/0",
                lastRefreshOk: null,
              }),
              counters: agentCounters.counters,
            },
          }
        : {}),
    };
  });
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
          required: [
            "consent",
            "name",
            "params",
            "client_id",
            "session_id",
            "page_id",
            "hit_index",
          ],
          properties: {
            consent: { type: "object" },
            name: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9_]{0,39}$" },
            params: { type: "object", maxProperties: 100 },
            client_id: { type: "string", pattern: "^[0-9]{1,20}\\.[0-9]{1,20}$" },
            session_id: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
            page_id: { type: "string", pattern: "^[0-9]{1,20}$" },
            hit_index: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
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
      if (
        !validEventName(ping.name) ||
        ping.name === "page_engagement" ||
        (ping.name !== "page_view" && !allowed.has(ping.name))
      )
        return reply.code(400).send({ error: "event_not_allowed" });
      const release = limiter.claim(req.ip);
      if (!release) return reply.code(429).send({ error: "rate_limit" });
      try {
        // No cookie or retry. Page identity is transient; IP supplies visitor geography.
        const result = await sendDeniedPing(
          config,
          ping,
          req.headers["user-agent"],
          fetcher,
          req.ip,
          label?.(req),
          pageLabelMemory,
          agentCounters.observe("pings", req.raw.rawHeaders),
          config,
        );
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
            bootstrap_token: {
              type: "string",
              pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            },
            page_id: { type: "string", pattern: "^[0-9]{1,16}$" },
            hit_index: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
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
        outcomes.set(req, "bot");
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
        if (seen.has(event.event_id)) {
          outcomes.set(req, "duplicate");
          return reply.code(204).send();
        }
        const verification = label?.(req);
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
        const bootstrapKey = event.bootstrap_token
          ? JSON.stringify([event.client_id, event.bootstrap_token])
          : undefined;
        const bootstrap =
          hasCookie || !bootstrapKey ? undefined : initialIdentities.get(bootstrapKey);
        const remembered =
          bootstrap && bootstrap.expires > Date.now() ? bootstrap.identity : undefined;
        let identity = remembered ?? serverIdentity(config, req.headers.cookie);
        if (!hasCookie && bootstrapKey && !remembered)
          remember(initialIdentities, bootstrapKey, { identity, expires: Date.now() + 60_000 });
        if (isRevoked("server:" + identity.clientId) || isRevoked(browserKey)) {
          outcomes.set(req, "withdrawn");
          return reply.code(204).send();
        }
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
        // Engagement time alone never creates a visitor. Without a cookie a late exit hit, for example
        // one sent after the browser dropped the cookie, would otherwise count as a new visitor with
        // a session and no page view (seen live on 2026-11-10: 5 in one run). A known visitor whose
        // session expired still opens a new one, as with the Google tag.
        if (identity.newClient && event.name === "page_engagement") {
          outcomes.set(req, "dropped");
          return reply.code(204).send();
        }
        // Nothing goes out in a session that is not open: the tracker retries this event.
        if (identity.newSession && opening.has(identity.clientId)) return reply.code(503).send();
        event.client_id = identity.clientId;
        event.session_id = identity.sessionId;
        event.session_started_ms = Math.min(identity.started, event.timestamp_ms);
        event.session_expires_ms = event.timestamp_ms + 30 * 60 * 1000;
        event.ip_override = req.ip;
        const starting = identity.newSession;
        const engaged = engage(
          config,
          identity,
          event.name,
          event.params.engagement_time_msec,
          starting,
        );
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
          {
            sessionStart: starting,
            firstVisit: starting && identity.newClient,
            sessionCount: identity.count,
            engaged,
            userAgent: req.headers["user-agent"],
            opened() {
              if (!starting) return;
              opened = true;
              // A browser that keeps no cookie must not open a new session with every event.
              identity.newSession = identity.newClient = false;
              remember(recent, identity.clientId, { identity, expires: Date.now() + 60_000 });
            },
          },
          verification,
          labelMemory,
          agentCounters.observe("events", req.raw.rawHeaders),
        );
        inFlight.set(event.event_id, delivery);
        let result: "sent" | "retry" | "dropped";
        try {
          result = await delivery;
          outcomes.set(req, result);
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
