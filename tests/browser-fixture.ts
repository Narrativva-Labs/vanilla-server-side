import { vi } from "vitest";
import { buildSync } from "esbuild";
import { runInNewContext } from "node:vm";
import { DEFAULT_EVENTS } from "../src/shared/settings.js";
const bundle = buildSync({
  entryPoints: ["src/client/index.ts"],
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
}).outputFiles[0]!.text;
export interface PageOptions {
  /** Extra script tag attributes, as `dataset` keys. */
  dataset?: Record<string, string>;
  sessionStorage?: Storage;
  /** Runs before the tracker, for example to publish a detector snapshot first. */
  setup?(host: Record<string, unknown>): void;
  /** Replaces globals of the page, for example a deterministic `crypto`. */
  context?: Record<string, unknown>;
}
export function page(history: unknown[] = [], options: PageOptions = {}) {
  let cookieReads = 0;
  const doc = Object.assign(new EventTarget(), {
    title: "Shop",
    visibilityState: "visible",
    currentScript: {
      src: "https://kx7qpa.example.com/s.js",
      dataset: { measurementId: "G-TEST", events: DEFAULT_EVENTS, ...options.dataset },
    },
    referrer: "",
  });
  Object.defineProperty(doc, "cookie", {
    get() {
      cookieReads++;
      throw Error("Cookie access prohibited");
    },
  });
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const host = Object.assign(new EventTarget(), {
    dataLayer: history,
    fetch: fetcher,
    setInterval: vi.fn(),
    setTimeout: vi.fn(),
    navigator: { language: "en-US", userAgent: "desktop" },
    screen: { width: 1920, height: 1080 },
    history: {
      pushState(_data: unknown, _title: string, url?: string | URL | null) {
        if (url) host.location.href = String(url);
      },
      replaceState(_data: unknown, _title: string, url?: string | URL | null) {
        if (url) host.location.href = String(url);
      },
    },
    location: { href: "https://shop.example/?email=private&utm_source=test" },
  });
  if (options.sessionStorage)
    Object.defineProperty(host, "sessionStorage", { value: options.sessionStorage });
  for (const key of [
    "localStorage",
    ...(options.sessionStorage ? [] : ["sessionStorage"]),
    "indexedDB",
  ])
    Object.defineProperty(host, key, {
      get() {
        throw Error("Storage access prohibited");
      },
    });
  const warnings = vi.fn();
  options.setup?.(host as unknown as Record<string, unknown>);
  runInNewContext(bundle, {
    window: host,
    document: doc,
    location: host.location,
    console: { warn: warnings },
    Date,
    crypto,
    URL,
    TextEncoder,
    AbortController,
    AbortSignal,
    ...options.context,
  });
  // Real gtag passes an Arguments object, rather than an array.
  function command(..._args: unknown[]) {
    host.dataLayer.push(arguments);
  }
  return { doc, host, fetcher, command, warnings, cookieReads: () => cookieReads };
}
