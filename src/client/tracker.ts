import {
  consentSnapshot,
  normalizeConsent,
  canTrack,
  clickConsent,
  cleanUrls,
  intersect,
  jsonSnapshot,
  redactAds,
  sanitizeUrl,
  type Consent,
} from "../shared/consent.js";
import {
  MAX_EVENT_AGE_MS,
  PAGE_TEXT_BYTES,
  SESSION_MS,
  shortenBytes,
  timely,
  type TrackingEvent,
} from "../shared/event.js";
import { clickIds } from "./click-ids.js";
import { trafficUpdateFields } from "../shared/traffic.js";
const PING_URL_BYTES = 1000;
export interface Runtime {
  title?(): string;
  device?(): TrackingEvent["device"];
  engagement?(): number;
  /** Optional browser class parameters, read again for every request. */
  traffic?(): Record<string, string>;
  /** With a readiness wait: whether the browser class is available now. */
  ready?(): boolean;
  /** With a readiness wait: called once when the first hit starts waiting. Must not release. */
  hold?(): void;
  href(): string;
  referrer(): string;
  warn(message: string): void;
  now(): number;
  defer?(task: () => void, delay: number): void;
  uuid(): string;
  fetch: typeof fetch;
}
export function createTracker(
  endpoint: string,
  runtime: Runtime,
  allowed: ReadonlySet<string>,
  deferDelivery = false,
  pings = true,
  holdMs = 0,
) {
  let consent = consentSnapshot(null);
  const purchases = new Set<string>();
  let pageId = "";
  let hitIndex = 0;
  let pageSent = false;
  let pageScheduled = false;
  let pagePinged = false;
  let pingSuppressed = false;
  let bannerKnown = false;
  let pingIdentity: { client_id: string; session_id: number; page_id: string } | undefined;
  let pingIndex = 0;
  // A stored refusal repeated at load is one deletion request; leaving the denied state allows another.
  let deletionRequested = false;
  const pingPurchases = new Set<string>();
  const pingQueue: { name: string; params: Record<string, unknown> }[] = [];
  let deliveryReady = !deferDelivery;
  let waitUntil = 0;
  // False while analytics is denied only by a default: events then wait for the visitor's choice.
  let settled = true;
  const waiting: {
    name: string;
    params: Record<string, unknown>;
    timestamp: number;
    deadline: number;
    unresolved: boolean;
    consent: Consent;
    clicks?: Record<string, string>;
  }[] = [];
  let memory:
    | { clientId: string; bootstrapToken: string; sessionId: number; started: number; last: number }
    | undefined;
  // Survives a denial: a later refusal must still name the requests already on their way.
  let lastClient: string | undefined;
  let flushing = false;
  let resolving = false;
  let generation = 0;
  const queue: { event: TrackingEvent; attempts: number; next: number }[] = [];
  const active = new Set<AbortController>();
  // Opt-in readiness wait, once per document: hits that may leave wait at most holdMs for the
  // browser class. One state for the deadline, the publication and leaving the page.
  let released = !(holdMs > 0);
  let holding = false;
  // The page as it was when its held automatic page view could have been sent.
  let heldPage: Record<string, unknown> | undefined;
  // Document scope: SPA routes and BFCache restores do not restart the detector.
  const trafficSent = new Set<string>();
  let ordinaryClass: string | undefined;
  let ordinaryStarted = false;
  function redundant(params: Record<string, unknown>) {
    return (
      params.traffic_phase === "final" &&
      params.traffic_class === "human" &&
      ordinaryStarted &&
      ordinaryClass === "human"
    );
  }
  function phasePending(phase: unknown) {
    return (
      waiting.some(
        (item) =>
          item.name === "traffic_class" &&
          item.timestamp <= runtime.now() + 5000 &&
          runtime.now() - item.timestamp <= MAX_EVENT_AGE_MS &&
          item.params.traffic_phase === phase,
      ) ||
      queue.some(
        (item) =>
          item.event.name === "traffic_class" &&
          timely(item.event, runtime.now()) &&
          item.event.params.traffic_phase === phase,
      ) ||
      pingQueue.some((item) => item.name === "traffic_class" && item.params.traffic_phase === phase)
    );
  }
  function held() {
    if (released) return false;
    if (!holding) {
      // Without a timer there could be no deadline, so nothing waits.
      if (!runtime.defer || runtime.ready?.()) {
        released = true;
        return false;
      }
      holding = true;
      runtime.defer?.(release, holdMs);
      runtime.hold?.();
    }
    // Also after subscribing, so a class published in between is not missed.
    if (runtime.ready?.()) released = true;
    return !released;
  }
  /** Marked before sending, so a reentrant release, timer or publication sends nothing twice. */
  function release() {
    if (released || !holding) return;
    released = true;
    void flush();
  }
  const pageFields = () => ({
    page_location: shortenBytes(sanitizeUrl(runtime.href()), PING_URL_BYTES),
    page_referrer: shortenBytes(sanitizeUrl(runtime.referrer()), PING_URL_BYTES),
    page_title: shortenBytes(runtime.title?.() ?? "", PAGE_TEXT_BYTES),
  });
  function update(
    value: unknown,
    waitMs = 0,
    explicitDenial = false,
    decided = true,
    readableBanner = false,
  ) {
    const next = consentSnapshot(value);
    const decisionChanged = settled !== decided;
    settled = decided;
    bannerKnown = readableBanner;
    // Also through an unknown state in between: requests of this visitor may be on their way.
    const withdrawal =
      (consent.analytics_storage === "granted" || memory !== undefined) &&
      next.analytics_storage === "denied";
    const previousWait = waitUntil;
    waitUntil = runtime.now() + Math.min(2000, Math.max(0, waitMs));
    // Wake at the command's deadline instead of waiting for the next periodic flush.
    if (!readableBanner && waitUntil > runtime.now() && waitUntil !== previousWait)
      runtime.defer?.(() => void flush(), waitUntil - runtime.now());
    if (waitMs > 0) {
      for (const item of waiting) item.deadline = Math.min(item.deadline, waitUntil);
    }
    if (!explicitDenial && !decisionChanged && JSON.stringify(next) === JSON.stringify(consent)) {
      void flush();
      return;
    }
    for (const item of waiting) {
      item.consent = intersect(item.consent, next);
    }
    for (const item of queue) {
      item.event.consent = intersect(item.event.consent, next);
    }
    consent = next;
    // Advertising changes preserve events and can only restrict their original permissions.
    if (consent.analytics_storage === "denied") {
      generation++;
      queue.length = 0;
      active.forEach((controller) => controller.abort());
      active.clear();
      // Events kept for an undecided visitor stay until the visitor decides.
      if (settled || explicitDenial || withdrawal) waiting.length = 0;
      const withdrawnClient = lastClient;
      memory = undefined;
      if (withdrawal || (explicitDenial && !deletionRequested)) {
        deletionRequested = true;
        void runtime
          .fetch(new URL("./p", endpoint).href, {
            method: "POST",
            credentials: "include",
            keepalive: true,
            referrerPolicy: "no-referrer",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client_id: withdrawnClient }),
          })
          .catch(() => {});
      }
      // A page already measured with consent is not counted again as a refused one.
      pagePinged ||= pageSent;
      pingSuppressed ||= pageSent;
      pageSent = false;
      pageScheduled = false;
    }
    if (consent.analytics_storage !== "denied") deletionRequested = false;
    if (canTrack(consent) && !pageSent && !pageScheduled) {
      pageScheduled = true;
      track("page_view", {}, true);
    }
    void flush();
  }
  function track(name: string, params: Record<string, unknown> = {}, automatic = false) {
    const trafficUpdate = name === "traffic_class";
    if (trafficUpdate) {
      const fields = trafficUpdateFields(params);
      if (
        !fields ||
        phasePending(fields.traffic_phase) ||
        (trafficSent.has(`e:${fields.traffic_phase}`) && canTrack(consent)) ||
        (trafficSent.has(`d:${fields.traffic_phase}`) && !canTrack(consent))
      )
        return;
      params = fields;
    }
    const automaticPage = name === "page_view" && automatic;
    const blockedPage = name === "page_view" && !automaticPage;
    const allowedName =
      trafficUpdate || allowed.has(name) || automaticPage || name === "page_engagement";
    if (!allowedName || blockedPage || !/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(name)) return;
    const transaction =
      name === "purchase" && typeof params.transaction_id === "string"
        ? params.transaction_id
        : undefined;
    if (transaction && purchases.has(transaction)) return;
    const pageLocation = sanitizeUrl(runtime.href());
    const pageReferrer = sanitizeUrl(runtime.referrer());
    params = trafficUpdate
      ? { ...pageFields(), ...params }
      : jsonSnapshot({
          page_title: runtime.title?.() ?? "",
          page_location: pageLocation,
          page_referrer: pageReferrer,
          ...params,
          engagement_time_msec: Math.max(0, Math.round(runtime.engagement?.() ?? 0)),
        });
    if (!canTrack(consent) && name !== "page_engagement") {
      if (pings) {
        if (pingQueue.length >= 50) pingQueue.shift();
        pingQueue.push({ name, params });
        ping();
      }
    }
    if (consent.analytics_storage === "denied" && settled) return;
    const clicks = name === "page_view" ? clickIds(runtime.href()) : undefined;
    const timestamp = runtime.now();
    const unresolved = !canTrack(consent);
    if (unresolved || timestamp < waitUntil) {
      if (waiting.length >= 50) waiting.shift();
      // Full events stay in memory until the visitor decides, independently of pings.
      const deadline = unresolved ? Infinity : waitUntil;
      waiting.push({
        name,
        params: trafficUpdate
          ? params
          : jsonSnapshot({
              page_location: pageLocation,
              page_referrer: pageReferrer,
              ...params,
            }),
        timestamp,
        deadline,
        unresolved,
        consent: { ...consent },
        clicks,
      });
      return;
    }
    enqueue(name, params, timestamp, undefined, clicks);
  }
  function enqueue(
    name: string,
    params: Record<string, unknown>,
    timestamp: number,
    originalConsent?: Consent,
    clicks?: Record<string, string>,
    immediate = false,
  ) {
    if (!canTrack(consent)) return;
    const now = runtime.now();
    if (memory && timestamp - memory.last >= SESSION_MS) {
      memory.sessionId = parseInt(runtime.uuid().replace(/-/g, "").slice(0, 12), 16);
      memory.started = timestamp;
    }
    const id = (memory ??= {
      clientId: `${parseInt(runtime.uuid().replace(/-/g, "").slice(0, 8), 16)}.${Math.floor(now / 1000)}`,
      bootstrapToken: runtime.uuid(),
      sessionId: parseInt(runtime.uuid().replace(/-/g, "").slice(0, 12), 16),
      started: now,
      last: timestamp,
    });
    id.last = timestamp;
    lastClient = id.clientId;
    const transaction =
      name === "purchase" && typeof params.transaction_id === "string"
        ? params.transaction_id
        : undefined;
    if (transaction && purchases.has(transaction)) return;
    params = jsonSnapshot(params);
    if (name === "page_view" || !pageId) {
      pageId = String(parseInt(runtime.uuid().replace(/-/g, "").slice(0, 12), 16));
      hitIndex = 0;
    }
    const event: TrackingEvent = {
      page_id: pageId,
      hit_index: ++hitIndex,
      event_id: runtime.uuid(),
      name,
      client_id: id.clientId,
      bootstrap_token: id.bootstrapToken,
      session_id: id.sessionId,
      session_started_ms: Math.min(id.started, timestamp),
      session_expires_ms: timestamp + SESSION_MS,
      timestamp_ms: timestamp,
      consent: originalConsent ? intersect(originalConsent, consent) : { ...consent },
      device: runtime.device?.(),
      params:
        name === "traffic_class"
          ? params
          : {
              page_location: sanitizeUrl(runtime.href()),
              page_referrer: sanitizeUrl(runtime.referrer()),
              ...params,
            },
    };
    // A page_location set by the site is cleaned like the automatic one.
    event.params = cleanUrls(jsonSnapshot(event.params)) as Record<string, unknown>;
    // Click IDs travel only in their own field and only with advertising permission.
    const snapshot = redactAds(jsonSnapshot(event)) as TrackingEvent;
    if (clicks && clickConsent(snapshot.consent)) snapshot.click_ids = clicks;
    if (transaction) {
      if (purchases.size >= 1000) purchases.delete(purchases.values().next().value!);
      purchases.add(transaction);
    }
    if (immediate) {
      // Exit engagement retains its existing best-effort transport.
      sendImmediate(snapshot);
      return;
    }
    if (queue.length >= 50) queue.shift();
    queue.push({ event: snapshot, attempts: 0, next: 0 });
    void flush();
  }
  function sendImmediate(event: TrackingEvent) {
    const body = requestBody(event);
    if (body) {
      if (event.name === "traffic_class") trafficSent.add(`e:${event.params.traffic_phase}`);
      void runtime
        .fetch(endpoint, {
          method: "POST",
          credentials: "include",
          keepalive: true,
          referrerPolicy: "no-referrer",
          headers: { "Content-Type": "application/json" },
          body,
        })
        .catch(() => {});
    }
  }
  function requestBody(queued: TrackingEvent) {
    // The latest browser class when the request leaves, not when the event was queued.
    const event = {
      ...queued,
      params:
        queued.name === "traffic_class"
          ? queued.params
          : { ...queued.params, ...runtime.traffic?.() },
    };
    // Consent may have narrowed while the event waited in the queue.
    const body = JSON.stringify(
      clickConsent(event.consent) ? event : { ...event, click_ids: undefined },
    );
    if (new TextEncoder().encode(body).byteLength > 64 * 1024) {
      runtime.warn(
        "[Vanilla Server-Side] Event skipped: UTF-8 payload exceeds the collector's 64 KiB limit. Reduce the event payload or number of items.",
      );
      return undefined;
    }
    if (queued.name !== "traffic_class" && !ordinaryStarted) {
      ordinaryStarted = true;
      ordinaryClass = event.params.traffic_class as string | undefined;
    }
    return body;
  }
  /** Best-effort cookieless events; identity lasts only for this page. */
  function ping() {
    if (!deliveryReady || !pings) return;
    if (canTrack(consent) || pageSent || pingSuppressed) {
      pingQueue.length = 0;
      heldPage = undefined;
      return;
    }
    if (consent.analytics_storage !== "denied" && !bannerKnown) return;
    if (!bannerKnown && runtime.now() < waitUntil) return;
    if ((!pagePinged || pingQueue.length) && held()) {
      heldPage ??= pageFields();
      return;
    }
    const device = runtime.device?.();
    const pingConsent = normalizeConsent(consent);
    pingConsent.analytics_storage = "denied";
    const events = pingQueue.splice(0);
    if (!pagePinged) events.unshift({ name: "page_view", params: heldPage ?? {} });
    heldPage = undefined;
    for (const item of events) {
      const transaction =
        item.name === "purchase" && typeof item.params.transaction_id === "string"
          ? item.params.transaction_id
          : undefined;
      if (
        item.name === "traffic_class" &&
        (redundant(item.params) || trafficSent.has(`d:${item.params.traffic_phase}`))
      )
        continue;
      if (transaction && pingPurchases.has(transaction)) continue;
      if (transaction) {
        if (pingPurchases.size >= 1000) pingPurchases.delete(pingPurchases.values().next().value!);
        pingPurchases.add(transaction);
      }
      pagePinged = true;
      pingIdentity ??= {
        client_id: `${parseInt(runtime.uuid().replace(/-/g, "").slice(0, 8), 16)}.${Math.floor(runtime.now() / 1000)}`,
        session_id: Math.max(1, Math.floor(runtime.now() / 1000)),
        page_id: String(parseInt(runtime.uuid().replace(/-/g, "").slice(0, 12), 16)),
      };
      const params =
        item.name === "traffic_class"
          ? (cleanUrls(redactAds(jsonSnapshot(item.params))) as Record<string, unknown>)
          : (cleanUrls(
              redactAds(
                jsonSnapshot({
                  ...pageFields(),
                  ...item.params,
                  ...runtime.traffic?.(),
                }),
              ),
            ) as Record<string, unknown>);
      // Never send enhanced-conversion data, including scalar values or nested item fields.
      function stripUserData(value: unknown): unknown {
        if (Array.isArray(value)) return value.map(stripUserData);
        if (value && typeof value === "object")
          return Object.fromEntries(
            Object.entries(value)
              .filter(([key]) => key.toLowerCase() !== "user_data")
              .map(([key, entry]) => [key, stripUserData(entry)]),
          );
        return value;
      }
      const body = JSON.stringify({
        ...pingIdentity,
        hit_index: ++pingIndex,
        name: item.name,
        consent: pingConsent,
        params: stripUserData(params),
        language: device?.language,
        screen_resolution: device?.screen_resolution,
      });
      if (new TextEncoder().encode(body).byteLength > 64 * 1024) continue;
      if (item.name !== "traffic_class" && !ordinaryStarted) {
        ordinaryStarted = true;
        ordinaryClass = params.traffic_class as string | undefined;
      }
      if (item.name === "traffic_class") trafficSent.add(`d:${item.params.traffic_phase}`);
      void runtime
        .fetch(new URL("./d", endpoint).href, {
          method: "POST",
          credentials: "omit",
          keepalive: true,
          referrerPolicy: "no-referrer",
          headers: { "Content-Type": "application/json" },
          body,
        })
        .catch(() => {});
    }
  }
  async function flush() {
    if (!deliveryReady) return;
    ping();
    if (resolving) return;
    resolving = true;
    try {
      for (const item of [...waiting]) {
        const known =
          consent.analytics_storage === "granted" ||
          (consent.analytics_storage === "denied" && settled);
        const expired = runtime.now() >= item.deadline;
        const mayResolve = known && runtime.now() >= waitUntil;
        if (!expired && !mayResolve) continue;
        waiting.splice(waiting.indexOf(item), 1);
        if (
          item.name === "traffic_class" &&
          !(
            item.timestamp <= runtime.now() + 5000 &&
            runtime.now() - item.timestamp <= MAX_EVENT_AGE_MS
          )
        )
          continue;
        if (canTrack(consent)) {
          // The choice resolves analytics permission; advertising never expands.
          const original = item.unresolved
            ? { ...item.consent, analytics_storage: consent.analytics_storage }
            : item.consent;
          enqueue(item.name, item.params, item.timestamp, original, item.clicks);
        }
      }
    } finally {
      resolving = false;
    }
    if (flushing || !canTrack(consent)) return;
    if (queue.length && held()) return;
    flushing = true;
    // Set while events wait behind a page view; the periodic flush picks them up.
    let waitingForPage = false;
    try {
      for (const item of [...queue]) {
        if (!queue.includes(item)) continue;
        const now = runtime.now();
        if (
          !timely(item.event, now) ||
          now - item.event.timestamp_ms > 30_000 ||
          item.attempts >= 3
        ) {
          queue.splice(queue.indexOf(item), 1);
          continue;
        }
        if (item.next > now) {
          // Events wait behind a page view, which may be the one opening the session.
          if (item.event.name === "page_view") {
            waitingForPage = true;
            break;
          }
          continue;
        }
        const effective = intersect(item.event.consent, consent);
        if (!canTrack(effective)) {
          queue.splice(queue.indexOf(item), 1);
          continue;
        }
        if (item.event.name === "traffic_class") {
          queue.splice(queue.indexOf(item), 1);
          const key = `e:${item.event.params.traffic_phase}`;
          if (!trafficSent.has(key) && !redundant(item.event.params)) {
            sendImmediate({ ...item.event, consent: effective });
          }
          continue;
        }
        const body = requestBody({ ...item.event, consent: effective });
        if (!body) {
          queue.splice(queue.indexOf(item), 1);
          continue;
        }
        const controller = new AbortController();
        active.add(controller);
        const epoch = generation;
        let retry = false;
        try {
          if (item.event.name === "page_view") pageSent = true;
          const response = await runtime.fetch(endpoint, {
            method: "POST",
            credentials: "include",
            keepalive: true,
            referrerPolicy: "no-referrer",
            headers: { "Content-Type": "application/json" },
            body,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
          });
          if (response.status === 413) {
            runtime.warn(
              "[Vanilla Server-Side] Event skipped: request exceeds the collector's 64 KiB limit (HTTP 413). Reduce the event payload or number of items.",
            );
          }
          retry = response.status === 429 || (response.status >= 500 && response.status < 600);
        } catch {
          retry = !controller.signal.aborted;
        } finally {
          active.delete(controller);
        }
        if (epoch !== generation || !queue.includes(item)) continue;
        if (retry) {
          item.attempts++;
          item.next = runtime.now() + item.attempts * 1000;
          if (item.event.name === "page_view") {
            waitingForPage = true;
            break;
          }
        } else queue.splice(queue.indexOf(item), 1);
      }
    } finally {
      flushing = false;
      if (!waitingForPage && queue.some((item) => item.next <= runtime.now()) && canTrack(consent))
        void Promise.resolve().then(flush);
    }
  }
  return {
    update,
    track: (name: string, params?: Record<string, unknown>) => track(name, params),
    flush,
    /** Closes the time of a page left by SPA navigation. An expired session is left to the new page. */
    leave(page: string) {
      const now = runtime.now();
      if (memory && now - memory.last >= SESSION_MS) {
        runtime.engagement?.(); // That time belonged to the old session and is dropped with it.
        return;
      }
      this.exit(undefined, page);
    },
    exit(elapsed = runtime.engagement?.() ?? 0, page = runtime.href()) {
      // Leaving: held hits go first, also denied pings, which have no exit hit of their own.
      release();
      if (!deliveryReady || !canTrack(consent) || runtime.now() < waitUntil || elapsed <= 0) return;
      // Fixed automatic fields only: custom ecommerce data cannot inflate the exit request.
      enqueue(
        "page_engagement",
        {
          page_location: shortenBytes(sanitizeUrl(page), PAGE_TEXT_BYTES),
          page_referrer: shortenBytes(sanitizeUrl(runtime.referrer()), PAGE_TEXT_BYTES),
          page_title: shortenBytes(runtime.title?.() ?? "", PAGE_TEXT_BYTES),
          engagement_time_msec: Math.max(0, Math.round(elapsed)),
        },
        runtime.now(),
        undefined,
        undefined,
        true,
      );
    },
    /** `refresh` reads the current consent first, for a page that was frozen for a while. */
    page(refresh?: () => void) {
      // Held hits of the page being left go before its page identity is reset.
      release();
      heldPage = undefined;
      pageSent = false;
      pagePinged = false;
      pingSuppressed = false;
      pingIdentity = undefined;
      pingIndex = 0;
      pingQueue.length = 0;
      // Set during the refresh, so a grant found there does not send its own page view.
      pageScheduled = true;
      refresh?.();
      pageScheduled = false;
      if (canTrack(consent)) {
        pageScheduled = true;
        track("page_view", {}, true);
      }
      void flush();
    },
    start() {
      deliveryReady = true;
      void flush();
    },
    release,
    pending: () => queue.length + waiting.length,
  };
}
