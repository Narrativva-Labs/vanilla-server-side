import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "./browser-fixture.js";

// Without data-vv-wait-ms, or with any value that clamps to 0, the tracker must make exactly the
// requests and timers it made before the readiness gate existed. The golden file was recorded
// from the tracker at 15d617d plus the bootstrap secret, before the gate; rerecord only for an
// intended change, with RECORD_VV_GOLDEN=1.
const golden = new URL("./fixtures/vv-wait-default-golden.json", import.meta.url);
afterEach(() => vi.useRealTimers());

const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const snapshot = (value: string, phase: string) =>
  Object.freeze({ class: value, score: 100, phase, version: "1.0.0" });
const granted = {
  analytics_storage: "granted",
  ad_storage: "granted",
  ad_user_data: "granted",
  ad_personalization: "granted",
};
const denied = {
  analytics_storage: "denied",
  ad_storage: "denied",
  ad_user_data: "denied",
  ad_personalization: "denied",
};

type Page = ReturnType<typeof page>;
type Step = (p: Page, clock: (ms: number) => void) => Promise<void> | void;
const tick = (p: Page) => (p.host.setInterval.mock.calls[0]![0] as () => void)();
const scenarios: Record<string, { history?: unknown[]; detector?: boolean; steps: Step[] }> = {
  "granted, events, SPA navigation and exit": {
    history: [["consent", "default", granted]],
    steps: [
      async (p, clock) => {
        clock(1200);
        p.command("event", "view_item", { value: 2, currency: "EUR", items: [{ item_id: "a" }] });
        p.host.dataLayer.push({ event: "generate_lead", value: 1 });
        await settle();
        clock(3000);
        p.host.history.pushState({}, "", "https://shop.example/b");
        tick(p);
        await settle();
        clock(2000);
        (p.doc as { visibilityState: string }).visibilityState = "hidden";
        p.doc.dispatchEvent(new Event("visibilitychange"));
        p.host.dispatchEvent(new Event("pagehide"));
        await settle();
      },
    ],
  },
  "denied default waiting for an update, then pings and exit": {
    history: [["consent", "default", { ...denied, wait_for_update: 500 }]],
    steps: [
      async (p, clock) => {
        p.command("event", "generate_lead", { value: 1 });
        await settle();
        clock(600);
        tick(p);
        await settle();
        p.command("event", "purchase", { transaction_id: "T1", value: 9, currency: "EUR" });
        await settle();
        p.host.dispatchEvent(new Event("pagehide"));
        await settle();
      },
    ],
  },
  "refusal then grant on the same page": {
    history: [
      ["consent", "default", denied],
      ["consent", "update", denied],
    ],
    steps: [
      async (p, clock) => {
        await settle();
        clock(800);
        p.command("consent", "update", granted);
        await settle();
        p.command("event", "generate_lead", { value: 1 });
        await settle();
        clock(500);
        p.command("consent", "update", denied);
        await settle();
      },
    ],
  },
  "back/forward cache restore": {
    history: [["consent", "update", granted]],
    steps: [
      async (p, clock) => {
        await settle();
        clock(900);
        p.host.dispatchEvent(new Event("pagehide"));
        clock(5000);
        p.host.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
        tick(p);
        await settle();
      },
    ],
  },
  "detector present before the tracker": {
    history: [["consent", "default", denied]],
    detector: true,
    steps: [
      async (p, clock) => {
        p.command("event", "generate_lead", { value: 1 });
        await settle();
        clock(300);
        p.command("consent", "update", granted);
        await settle();
      },
    ],
  },
  "detector publishing after the first hit": {
    history: [["consent", "default", denied]],
    steps: [
      async (p, clock) => {
        await settle();
        clock(150);
        (p.host as unknown as { __visitorVerdict: object }).__visitorVerdict = snapshot(
          "automated",
          "initial",
        );
        p.host.dataLayer.push({ event: "traffic_class", traffic_class: "automated" });
        p.command("event", "generate_lead", { value: 1 });
        await settle();
        clock(300);
        p.command("consent", "update", granted);
        await settle();
      },
    ],
  },
};

async function record(dataset: Record<string, string>) {
  const out: Record<string, unknown> = {};
  for (const [name, scenario] of Object.entries(scenarios)) {
    let now = Date.UTC(2026, 10, 21, 12);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    let n = 0;
    const randomUUID = () => {
      const h = ((++n * 2654435761) >>> 0).toString(16).padStart(8, "0");
      return `${h}-${h.slice(0, 4)}-4${h.slice(1, 4)}-8${h.slice(5, 8)}-${h}${h.slice(0, 4)}`;
    };
    // A copy: the array becomes the page's dataLayer and collects its pushes.
    const p = page([...(scenario.history ?? [])], {
      dataset,
      context: { crypto: { randomUUID } },
      setup: scenario.detector
        ? (host) => {
            host.__visitorVerdict = snapshot("suspicious", "initial");
          }
        : undefined,
    });
    const clock = (ms: number) => vi.setSystemTime((now += ms));
    await settle();
    for (const step of scenario.steps) await step(p, clock);
    out[name] = {
      requests: p.fetcher.mock.calls.map(([url, init]) => ({
        url: String(url),
        ...init,
        signal: init?.signal ? "signal" : undefined,
      })),
      timeouts: p.host.setTimeout.mock.calls.map(([, delay]) => delay),
      intervals: p.host.setInterval.mock.calls.map(([, delay]) => delay),
    };
    vi.useRealTimers();
  }
  return JSON.parse(JSON.stringify(out));
}

if (process.env.RECORD_VV_GOLDEN) {
  it("records the default request flow", async () => {
    writeFileSync(golden, JSON.stringify(await record({}), null, 2) + "\n");
  });
} else {
  const expected = existsSync(golden) ? JSON.parse(readFileSync(golden, "utf8")) : undefined;
  for (const [label, dataset] of [
    ["absent", {}],
    ["0", { vvWaitMs: "0" }],
    ["empty", { vvWaitMs: "" }],
    ["negative", { vvWaitMs: "-250" }],
    ["not a number", { vvWaitMs: "soon" }],
    ["below one millisecond", { vvWaitMs: "0.5" }],
  ] as const)
    it(`data-vv-wait-ms ${label} keeps the exact default requests and timers`, async () => {
      expect(expected).toBeDefined();
      expect(await record(dataset)).toEqual(expected);
    });
  it("the recorded default flow covers pings, full events, deletion, exit and timers", () => {
    const all = Object.values(expected as Record<string, { requests: { url: string }[] }>);
    const paths = all.flatMap((s) => s.requests.map((r) => new URL(r.url).pathname));
    for (const path of ["/e", "/d", "/p"]) expect(paths).toContain(path);
    const bodies = all.flatMap((s) =>
      s.requests.map((r) => (r as { body?: string }).body ?? "").join("\n"),
    );
    expect(bodies.join("\n")).toContain('"traffic_class":"suspicious"');
    expect(bodies.join("\n")).toContain('"traffic_class":"automated"');
    expect(bodies.join("\n")).toContain('"name":"page_engagement"');
  });
}
