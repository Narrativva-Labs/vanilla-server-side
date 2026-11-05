import { deviceModel, deviceBrowser } from "./device.js";
import { createTracker } from "./tracker.js";
import { createConsentObserver } from "./consent.js";
import { normalizeEventItem } from "./data-layer.js";
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
  let visibleSince = 0;
  let visibleTime = 0;
  function engagement() {
    const now = Date.now();
    if (visibleSince) visibleTime += now - visibleSince;
    visibleSince = engagementEnabled && document.visibilityState !== "hidden" ? now : 0;
    const elapsed = visibleTime;
    visibleTime = 0;
    return elapsed;
  }
  const tracker = createTracker(
    new URL("./e", script.src).href,
    {
      title: () => document.title,
      device: () => ({
        browser: deviceBrowser(window.navigator?.userAgent ?? ""),
        model: deviceModel(window.navigator?.userAgent ?? ""),
        category: /Mobi|Android/i.test(window.navigator?.userAgent ?? "") ? "mobile" : "desktop",
        language: window.navigator?.language ?? "",
        screen_resolution: `${window.screen?.width ?? 0}x${window.screen?.height ?? 0}`,
      }),
      engagement,
      href: () => location.href,
      referrer: () => document.referrer,
      now: Date.now,
      uuid: () => crypto.randomUUID(),
      fetch: window.fetch.bind(window),
      warn,
    },
    new Set((script.dataset.events ?? "").split(",")),
    true,
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
    // Count only visible time after the effective analytics grant; unknown stays at zero.
    const enabled = state.analytics_storage === "granted" && waitMs === 0;
    if (enabled !== engagementEnabled) {
      engagementEnabled = enabled;
      visibleTime = 0;
      visibleSince = enabled && document.visibilityState !== "hidden" ? Date.now() : 0;
    }
    tracker.update(state, waitMs, observer.takeAnalyticsDenialUpdate());
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
  // Preserve chronological consent and events, including inline purchases before defer runs.
  [...layer].forEach(process);
  sync();
  tracker.start();
  const push = layer.push;
  layer.push = function (...items: unknown[]) {
    try {
      items.forEach(process);
    } finally {
      return push.apply(this, items);
    }
  };
  let lastPage = location.href;
  const navigate = () => {
    if (location.href === lastPage) return;
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
  window.addEventListener("pagehide", () => {
    tracker.exit();
  });
  document.addEventListener?.("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      const elapsed = engagement();
      tracker.exit(elapsed);
    } else {
      visibleSince = engagementEnabled ? Date.now() : 0;
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
