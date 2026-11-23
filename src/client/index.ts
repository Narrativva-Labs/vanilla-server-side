import { deviceCategory, deviceModel, deviceBrowser } from "./device.js";
import { createTracker } from "./tracker.js";
import { createConsentObserver } from "./consent.js";
import { normalizeEventItem } from "./data-layer.js";
import { createVerdictEcho } from "./server-verdict.js";
import { readTraffic } from "./traffic.js";
import { cookiebot } from "./cmp/cookiebot.js";
import { cookieconsent } from "./cmp/cookieconsent.js";
import { cookieyes } from "./cmp/cookieyes.js";
import { shoptet } from "./cmp/shoptet.js";

const script = document.currentScript as HTMLScriptElement | null;
const win = window as unknown as Window & {
  dataLayer: unknown[];
  __vanillaGA?: boolean;
};
if (script && !win.__vanillaGA) {
  win.__vanillaGA = true;
  // Some banners, such as CookieYes from its CDN, skip Google commands without a dataLayer.
  const layer = (win.dataLayer = win.dataLayer || []);
  const warn = (message: string) => console.warn(message);
  let engagementEnabled = false;
  // After a SPA navigation the referrer is the previous virtual page, as Google asks for.
  let previousPage: string | undefined;
  // Like the Google tag, visible time counts from page load and leaves only with a later grant.
  // A refusal or withdrawal discards it, and time while refused is never counted.
  let counting = true;
  let visibleSince = document.visibilityState !== "hidden" ? Date.now() : 0;
  let visibleTime = 0;
  function engagement() {
    const now = Date.now();
    if (visibleSince) visibleTime += now - visibleSince;
    visibleSince = counting && document.visibilityState !== "hidden" ? now : 0;
    const elapsed = visibleTime;
    visibleTime = 0;
    return elapsed;
  }
  // Opt-in data-vv-wait-ms: the first hits wait at most this long for the Visitor Verdict class.
  const vvWait = Math.min(1000, Math.max(0, Math.floor(Number(script.dataset.vvWaitMs)) || 0));
  const vvReady = () => "traffic_class" in readTraffic(window);
  let vvWaiting = false;
  let vvChecking = false;
  function vvCheck() {
    if (!vvWaiting || vvChecking) return;
    vvChecking = true;
    try {
      if (vvReady()) {
        vvWaiting = false;
        tracker.release();
      }
    } finally {
      vvChecking = false;
    }
  }
  /** Listens for the detector's publication: its dataLayer event, and a bounded poll of the global. */
  function vvHold() {
    vvWaiting = true;
    try {
      const name =
        script?.dataset.vvLayer ||
        (window as { visitorVerdictConfig?: { dataLayerName?: unknown } }).visitorVerdictConfig
          ?.dataLayerName;
      const other =
        typeof name === "string" && name !== "dataLayer"
          ? (window as unknown as Record<string, { push?: unknown } | undefined>)[name]
          : undefined;
      const push = other?.push;
      if (typeof push === "function")
        other!.push = function (this: unknown, ...items: unknown[]) {
          try {
            return push.apply(this, items);
          } finally {
            vvCheck();
          }
        };
    } catch {
      // A missing, replaced or hostile layer leaves the poll and the deadline.
    }
    let polls = Math.ceil(vvWait / 50);
    const poll = () => {
      vvCheck();
      if (--polls <= 0) vvWaiting = false;
      if (vvWaiting) window.setTimeout(poll, 50);
    };
    window.setTimeout(poll, 50);
  }
  const verdict =
    script.dataset.verdictEcho === "on"
      ? createVerdictEcho(window, Date.now, script.dataset.vvLayer)
      : undefined;
  const tracker = createTracker(
    new URL("./e", script.src).href,
    {
      keepQueryParams: (script.dataset.keepQueryParams ?? "").split(",").filter(Boolean),
      title: () => document.title,
      device: () => ({
        browser: deviceBrowser(window.navigator?.userAgent ?? ""),
        model: deviceModel(window.navigator?.userAgent ?? ""),
        category: deviceCategory(window.navigator?.userAgent ?? ""),
        language: window.navigator?.language ?? "",
        screen_resolution: `${window.screen?.width ?? 0}x${window.screen?.height ?? 0}`,
      }),
      engagement,
      verdict,
      verdictConsent: verdict?.consent,
      traffic: () => readTraffic(window),
      ready: vvReady,
      hold: vvHold,
      href: () => location.href,
      referrer: () => previousPage ?? document.referrer,
      now: Date.now,
      defer: (task, delay) => {
        window.setTimeout(task, delay);
      },
      uuid: () => crypto.randomUUID(),
      fetch: window.fetch.bind(window),
      warn,
    },
    new Set((script.dataset.events ?? "").split(",")),
    true,
    script.dataset.pings !== "off",
    vvWait,
  );
  const observer = createConsentObserver();
  const adapters = [
    cookiebot(window),
    cookieconsent(
      window,
      script.dataset.ccAnalyticsCategory ?? "analytics",
      (script.dataset.ccAdsCategories ?? "ads,marketing")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    cookieyes(window, document),
    shoptet(window),
  ];

  function readBanner() {
    observer.fallback(
      adapters.map((adapter) => adapter.read()).find((value) => value !== undefined),
    );
  }
  function sync() {
    readBanner();
    const state = observer.snapshot();
    const waitMs = observer.waitMs();
    engagementEnabled = state.analytics_storage === "granted" && waitMs === 0;
    const count = !(state.analytics_storage === "denied" && observer.decided());
    if (count !== counting) {
      counting = count;
      visibleTime = 0;
      visibleSince = count && document.visibilityState !== "hidden" ? Date.now() : 0;
    }
    tracker.update(
      state,
      waitMs,
      observer.takeAnalyticsDenialUpdate(),
      observer.decided(),
      observer.bannerKnown(),
    );
  }
  function process(item: unknown) {
    try {
      if (observer.observe(item, readBanner)) {
        sync();
        return;
      }
      const event = normalizeEventItem(item);
      if (event) tracker.track(event.name, event.params);
    } catch {
      warn("[Vanilla Server-Side] Invalid event skipped. Check for cycles or unsupported values.");
    }
  }
  adapters.forEach((adapter) => adapter.subscribe(sync));
  // Preserve chronological consent and events, including inline purchases from before this script ran.
  [...layer].forEach(process);
  sync();
  tracker.start();
  const push = layer.push;
  layer.push = function (...items: unknown[]) {
    try {
      // The detector publishes its global before this push.
      vvCheck();
      items.forEach(process);
    } finally {
      return push.apply(this, items);
    }
  };
  // Subscribe even when the optional initial-class wait is disabled. The detector's
  // configured layer can differ from the consent/ecommerce dataLayer.
  try {
    const name =
      script.dataset.vvLayer ||
      (window as { visitorVerdictConfig?: { dataLayerName?: unknown } }).visitorVerdictConfig
        ?.dataLayerName;
    if (
      typeof name === "string" &&
      name !== "dataLayer" &&
      name.length > 0 &&
      name.length <= 128 &&
      !["__proto__", "prototype", "constructor"].includes(name)
    ) {
      const host = window as unknown as Record<string, unknown>;
      const other = (host[name] ??= []) as {
        length: number;
        [key: number]: unknown;
        push: (...items: unknown[]) => unknown;
      };
      const publish = (item: unknown) => {
        const event = normalizeEventItem(item);
        if (event?.name === "traffic_class") tracker.track(event.name, event.params);
      };
      if (
        typeof other.length === "number" &&
        Number.isFinite(other.length) &&
        other.length >= 0 &&
        Number.isInteger(other.length) &&
        typeof other.push === "function"
      ) {
        Array.prototype.forEach.call(other, publish);
        const original = other.push;
        other.push = function (...items: unknown[]) {
          try {
            items.forEach(publish);
            vvCheck();
          } finally {
            return original.apply(this, items);
          }
        };
      }
    }
  } catch {
    // A hostile custom layer cannot prevent ordinary collection.
  }
  let lastPage = location.href;
  const withoutHash = (href: string) => href.split("#")[0];
  const navigate = () => {
    // Like the Google tag, a change of the fragment alone is the same page.
    if (withoutHash(location.href) === withoutHash(lastPage)) {
      lastPage = location.href;
      return;
    }
    // The time spent so far belongs to the page being left.
    tracker.leave(lastPage);
    // A page visited without settled consent is never reported, not even as a referrer.
    previousPage = engagementEnabled ? lastPage : undefined;
    lastPage = location.href;
    tracker.page();
  };
  for (const method of ["pushState", "replaceState"] as const) {
    if (!window.history) continue;
    const original = window.history[method];
    window.history[method] = function (...args) {
      original.apply(this, args);
      navigate();
    };
  }
  window.addEventListener("popstate", navigate);
  // A page restored from the back/forward cache runs no script again.
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    lastPage = location.href;
    previousPage = undefined;
    visibleSince = counting && document.visibilityState !== "hidden" ? Date.now() : 0;
    visibleTime = 0;
    tracker.page(sync);
  });
  window.addEventListener("pagehide", () => {
    const elapsed = engagement();
    // The page is gone: a visibilitychange that follows must not report a few more milliseconds.
    visibleSince = 0;
    tracker.exit(elapsed);
  });
  document.addEventListener?.("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      const elapsed = engagement();
      tracker.exit(elapsed);
    } else {
      visibleSince = counting ? Date.now() : 0;
      visibleTime = 0;
    }
  });
  window.setInterval(() => {
    sync();
    void tracker.flush();
  }, 500);
  window.addEventListener("online", () => void tracker.flush());
  window.setTimeout(() => {
    // A supported banner that is still waiting for the visitor is the normal undecided state.
    if (
      observer.snapshot().analytics_storage === "unknown" &&
      adapters.every((adapter) => adapter.read() === undefined)
    ) {
      warn(
        "[Vanilla Server-Side] No resolved analytics consent received. Use direct gtag consent commands or a supported banner. GTM Consent API alone is not visible to this tracker.",
      );
    }
  }, 2000);
}
