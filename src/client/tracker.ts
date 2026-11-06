import {
  consentSnapshot,
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
  PAGE_TEXT_BYTES,
  SESSION_MS,
  shortenBytes,
  timely,
  type TrackingEvent,
} from "../shared/event.js";
import { clickIds } from "./click-ids.js";
const PING_URL_BYTES = 1000;
const PING_DELAY_MS = 2000;
export interface Runtime {
  title?(): string;
  device?(): TrackingEvent["device"];
  engagement?(): number;
  href(): string;
  referrer(): string;
  warn(message: string): void;
  now(): number;
  uuid(): string;
  fetch: typeof fetch;
}
export function createTracker(
  endpoint: string,
  runtime: Runtime,
  allowed: ReadonlySet<string>,
  deferDelivery = false,
  pings = true,
) {
  let consent = consentSnapshot(null);
  const purchases = new Set<string>();
  let pageSent = false;
  let pageScheduled = false;
  let pagePinged = false;
  let pingAt = 0;
  let deliveryReady = !deferDelivery;
  let waitUntil = 0;
  const waiting: {
    name: string;
    params: Record<string, unknown>;
    timestamp: number;
    deadline: number;
    unresolved: boolean;
    consent: Consent;
    clicks?: Record<string, string>;
  }[] = [];
  let memory: { clientId: string; sessionId: number; started: number; last: number } | undefined;
  // Survives a denial: a later refusal must still name the requests already on their way.
  let lastClient: string | undefined;
  let flushing = false;
  let resolving = false;
  let generation = 0;
  const queue: { event: TrackingEvent; attempts: number; next: number }[] = [];
  const active = new Set<AbortController>();
  function update(value: unknown, waitMs = 0, explicitDenial = false) {
    const next = consentSnapshot(value);
    const withdrawal =
      consent.analytics_storage === "granted" && next.analytics_storage === "denied";
    waitUntil = runtime.now() + Math.min(2000, Math.max(0, waitMs));
    if (waitMs > 0) {
      for (const item of waiting) item.deadline = Math.min(item.deadline, waitUntil);
    }
    if (!explicitDenial && JSON.stringify(next) === JSON.stringify(consent)) return;
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
      waiting.length = 0;
      const withdrawnClient = lastClient;
      memory = undefined;
      if (explicitDenial || withdrawal)
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
      // A page already measured with consent is not counted again as a refused one.
      pagePinged ||= pageSent;
      pageSent = false;
      pageScheduled = false;
    }
    if (canTrack(consent) && !pageSent && !pageScheduled) {
      pageScheduled = true;
      track("page_view", {}, true);
    }
    void flush();
  }
  function track(name: string, params: Record<string, unknown> = {}, automatic = false) {
    const automaticPage = name === "page_view" && automatic;
    const blockedPage = name === "page_view" && !automaticPage;
    const allowedName = allowed.has(name) || automaticPage || name === "page_engagement";
    if (!allowedName || blockedPage || !/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(name)) return;
    if (consent.analytics_storage === "denied") return;
    const transaction =
      name === "purchase" && typeof params.transaction_id === "string"
        ? params.transaction_id
        : undefined;
    if (transaction && purchases.has(transaction)) return;
    const pageLocation = sanitizeUrl(runtime.href());
    const pageReferrer = sanitizeUrl(runtime.referrer());
    params = jsonSnapshot({
      page_title: runtime.title?.() ?? "",
      page_location: pageLocation,
      page_referrer: pageReferrer,
      ...params,
      engagement_time_msec: Math.max(0, Math.round(runtime.engagement?.() ?? 0)),
    });
    const clicks = name === "page_view" ? clickIds(runtime.href()) : undefined;
    const timestamp = runtime.now();
    const unresolved = consent.analytics_storage === "unknown";
    if (unresolved || timestamp < waitUntil) {
      if (waiting.length >= 50) waiting.shift();
      const deadline = timestamp < waitUntil ? waitUntil : timestamp + 2000;
      waiting.push({
        name,
        params: jsonSnapshot({
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
    if (
      memory &&
      (timestamp - memory.last >= SESSION_MS || timestamp - memory.started >= 24 * 60 * 60 * 1000)
    ) {
      memory.sessionId = parseInt(runtime.uuid().replace(/-/g, "").slice(0, 12), 16);
      memory.started = timestamp;
    }
    const id = (memory ??= {
      clientId: `${parseInt(runtime.uuid().replace(/-/g, "").slice(0, 8), 16)}.${Math.floor(now / 1000)}`,
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
    const event: TrackingEvent = {
      event_id: runtime.uuid(),
      name,
      client_id: id.clientId,
      session_id: id.sessionId,
      session_started_ms: Math.min(id.started, timestamp),
      session_expires_ms: timestamp + SESSION_MS,
      timestamp_ms: timestamp,
      consent: originalConsent ? intersect(originalConsent, consent) : { ...consent },
      device: runtime.device?.(),
      params: {
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
      // One small best-effort request; never wait for or retry the ordinary event queue.
      const body = requestBody(snapshot);
      if (body)
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
      return;
    }
    if (queue.length >= 50) queue.shift();
    queue.push({ event: snapshot, attempts: 0, next: 0 });
    void flush();
  }
  function requestBody(event: TrackingEvent) {
    // Consent may have narrowed while the event waited in the queue.
    const body = JSON.stringify(
      clickConsent(event.consent) ? event : { ...event, click_ids: undefined },
    );
    if (new TextEncoder().encode(body).byteLength > 32 * 1024) {
      runtime.warn(
        "[Vanilla Server-Side] Event skipped: UTF-8 payload exceeds the collector's 32 KiB limit. Reduce the event payload or number of items.",
      );
      return undefined;
    }
    return body;
  }
  /** One limited page ping without analytics consent, as Google tag does in Advanced Consent Mode. */
  function ping() {
    if (!pings || consent.analytics_storage !== "denied") {
      pingAt = 0;
      return;
    }
    // A banner restoring a stored grant must not leave a refusal behind on every page load.
    pingAt ||= runtime.now() + PING_DELAY_MS;
    if (pagePinged || runtime.now() < pingAt) return;
    pagePinged = true;
    const device = runtime.device?.();
    void runtime
      .fetch(new URL("./d", endpoint).href, {
        method: "POST",
        credentials: "omit",
        keepalive: true,
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          consent,
          page_location: shortenBytes(sanitizeUrl(runtime.href()), PING_URL_BYTES),
          page_referrer: shortenBytes(sanitizeUrl(runtime.referrer()), PING_URL_BYTES),
          page_title: shortenBytes(redactAds(runtime.title?.() ?? "") as string, PAGE_TEXT_BYTES),
          language: device?.language,
          screen_resolution: device?.screen_resolution,
        }),
      })
      .catch(() => {});
  }
  async function flush() {
    if (!deliveryReady) return;
    ping();
    if (resolving) return;
    resolving = true;
    try {
      for (const item of [...waiting]) {
        const known = consent.analytics_storage !== "unknown";
        const expired = runtime.now() >= item.deadline;
        const mayResolve = known && runtime.now() >= waitUntil;
        if (!expired && !mayResolve) continue;
        waiting.splice(waiting.indexOf(item), 1);
        const tooLateForGrant = item.unresolved && runtime.now() > item.deadline;
        if (!tooLateForGrant && canTrack(consent)) {
          // Waiting may resolve analytics permission; advertising never expands.
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
              "[Vanilla Server-Side] Event skipped: request exceeds the collector's 32 KiB limit (HTTP 413). Reduce the event payload or number of items.",
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
    exit(elapsed = runtime.engagement?.() ?? 0) {
      if (!deliveryReady || !canTrack(consent) || runtime.now() < waitUntil || elapsed <= 0) return;
      // Fixed automatic fields only: custom ecommerce data cannot inflate the exit request.
      enqueue(
        "page_engagement",
        {
          page_location: shortenBytes(sanitizeUrl(runtime.href()), PAGE_TEXT_BYTES),
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
      pageSent = false;
      pagePinged = false;
      pingAt = 0;
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
    pending: () => queue.length + waiting.length,
  };
}
