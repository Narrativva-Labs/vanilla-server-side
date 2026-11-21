import { afterEach, expect, it, vi } from "vitest";
import { page, type PageOptions } from "./browser-fixture.js";

// data-vv-wait-ms: the first hits of a document wait at most that long for the Visitor Verdict
// initial snapshot. The default flow without the attribute is pinned in vv-wait-default.test.ts.
afterEach(() => vi.useRealTimers());

type Page = ReturnType<typeof page>;
type Hit = {
  path: string;
  name?: string;
  client_id?: string;
  session_id?: number;
  page_id?: string;
  hit_index?: number;
  event_id?: string;
  timestamp_ms?: number;
  consent?: { analytics_storage?: string };
  params?: Record<string, unknown>;
  init: RequestInit;
};
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const snapshot = (value: string, phase = "initial") =>
  Object.freeze({ class: value, score: 100, phase, version: "1.0.0" });
const denied = { analytics_storage: "denied", ad_storage: "denied" };
const granted = {
  analytics_storage: "granted",
  ad_storage: "granted",
  ad_user_data: "granted",
  ad_personalization: "granted",
};
type Host = Page["host"] & Record<string, unknown> & { dataLayer: unknown[] };

function gated(wait: string | undefined, history: unknown[] = [], options: PageOptions = {}) {
  const p = page(history, {
    ...options,
    dataset: wait === undefined ? {} : { vvWaitMs: wait },
  });
  const host = p.host as unknown as Host;
  const hits = (): Hit[] =>
    p.fetcher.mock.calls.map(([url, init]) => ({
      path: new URL(String(url)).pathname,
      init: init!,
      ...JSON.parse(String(init?.body ?? "{}")),
    }));
  const names = () => hits().map((hit) => `${hit.path} ${hit.name ?? ""}`.trim());
  const fired = new Set<number>();
  /** Runs the page timers with this delay that have not run yet, like the browser would. */
  const fire = (delay: number) => {
    let count = 0;
    p.host.setTimeout.mock.calls.forEach(([task, ms], index) => {
      if (ms !== delay || fired.has(index)) return;
      fired.add(index);
      count++;
      (task as () => void)();
    });
    return count;
  };
  const delays = () => p.host.setTimeout.mock.calls.map(([, ms]) => ms);
  const tick = () => (p.host.setInterval.mock.calls[0]![0] as () => void)();
  /** What the detector does: replace the frozen global, then push its event to its layer. */
  const publish = (value = "automated", phase = "initial", layer = "dataLayer") => {
    host.__visitorVerdict = snapshot(value, phase);
    const target = ((host[layer] as unknown[] | undefined) ??= []);
    target.push({
      event: "traffic_class",
      traffic_class: value,
      traffic_phase: phase,
      traffic_score: 100,
      traffic_version: "1.0.0",
    });
  };
  return { ...p, host, hits, names, fire, delays, tick, publish };
}
const leave = (p: ReturnType<typeof gated>, kind: "pagehide" | "hidden") => {
  if (kind === "pagehide") p.host.dispatchEvent(new Event("pagehide"));
  else {
    (p.doc as { visibilityState: string }).visibilityState = "hidden";
    p.doc.dispatchEvent(new Event("visibilitychange"));
  }
};

it("a snapshot published before the tracker starts releases at once, with no deadline", async () => {
  for (const consent of [denied, granted]) {
    const p = gated("1000", [["consent", "default", consent]], {
      setup: (host) => {
        host.__visitorVerdict = snapshot("automated");
      },
    });
    await settle();
    const [hit] = p.hits();
    expect(p.names()).toEqual([consent === denied ? "/d page_view" : "/e page_view"]);
    expect(hit!.params).toMatchObject({ traffic_class: "automated", traffic_phase: "initial" });
    expect(hit!.consent?.analytics_storage).toBe(consent.analytics_storage);
    expect(p.delays()).not.toContain(1000);
    expect(p.delays()).not.toContain(50);
  }
});

it("a denied page view and later pings wait for the initial snapshot published during the wait", async () => {
  const p = gated("1000", [["consent", "default", denied]]);
  await settle();
  expect(p.hits()).toHaveLength(0);
  expect(p.delays().filter((ms) => ms === 1000)).toHaveLength(1);
  p.command("event", "generate_lead", { value: 1 });
  p.command("event", "purchase", { transaction_id: "T1", value: 9, currency: "EUR" });
  p.tick();
  await settle();
  expect(p.hits()).toHaveLength(0);
  // Released synchronously inside the detector's push.
  p.publish("automated");
  const hits = p.hits();
  expect(p.names()).toEqual(["/d page_view", "/d generate_lead", "/d purchase"]);
  expect(hits.map((hit) => hit.hit_index)).toEqual([1, 2, 3]);
  expect(new Set(hits.map((hit) => hit.client_id)).size).toBe(1);
  expect(new Set(hits.map((hit) => hit.page_id)).size).toBe(1);
  for (const hit of hits) {
    expect(hit.consent?.analytics_storage).toBe("denied");
    expect(hit.params).toMatchObject({ traffic_class: "automated", traffic_phase: "initial" });
    expect(hit.init).toMatchObject({ keepalive: true, credentials: "omit" });
  }
  // The detector's own event stays a notification, and the deadline later sends nothing.
  expect(p.fire(1000)).toBe(1);
  p.tick();
  await settle();
  expect(p.hits()).toHaveLength(3);
});

it("full events wait for the snapshot and keep their order, identity and original timestamps", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.now();
  const p = gated("1000", [["consent", "default", granted]]);
  await settle();
  vi.setSystemTime(start + 100);
  p.command("event", "view_item", { value: 2, currency: "EUR", items: [{ item_id: "a" }] });
  vi.setSystemTime(start + 200);
  p.host.dataLayer.push({ event: "generate_lead", value: 1 });
  await settle();
  expect(p.hits()).toHaveLength(0);
  vi.setSystemTime(start + 400);
  p.publish("suspicious");
  await settle();
  const hits = p.hits();
  expect(p.names()).toEqual(["/e page_view", "/e view_item", "/e generate_lead"]);
  expect(hits.map((hit) => hit.timestamp_ms)).toEqual([start, start + 100, start + 200]);
  expect(hits.map((hit) => hit.hit_index)).toEqual([1, 2, 3]);
  expect(new Set(hits.map((hit) => hit.event_id)).size).toBe(3);
  expect(new Set(hits.map((hit) => `${hit.client_id}/${hit.session_id}`)).size).toBe(1);
  for (const hit of hits) {
    expect(hit.consent?.analytics_storage).toBe("granted");
    expect(hit.params).toMatchObject({ traffic_class: "suspicious", traffic_phase: "initial" });
    expect(hit.init).toMatchObject({ keepalive: true, credentials: "include" });
  }
});

it("without a detector the deadline releases the held hits without a class", async () => {
  for (const consent of [denied, granted]) {
    const p = gated("1000", [["consent", "default", consent]]);
    p.command("event", "generate_lead", { value: 1 });
    await settle();
    expect(p.hits()).toHaveLength(0);
    expect(p.fire(1000)).toBe(1);
    await settle();
    const path = consent === denied ? "/d" : "/e";
    expect(p.names()).toEqual([`${path} page_view`, `${path} generate_lead`]);
    for (const hit of p.hits()) {
      expect(hit.params).not.toHaveProperty("traffic_class");
      expect(hit.consent?.analytics_storage).toBe(consent.analytics_storage);
    }
  }
});

it("the wait is clamped to 1000 ms and a fractional value is rounded down", async () => {
  for (const [value, delay] of [
    ["5000", 1000],
    ["Infinity", 1000],
    ["250", 250],
    ["250.9", 250],
    ["1", 1],
  ] as const) {
    const p = gated(value, [["consent", "default", denied]]);
    await settle();
    expect(p.hits()).toHaveLength(0);
    expect(p.fire(delay)).toBe(1);
    expect(p.names()).toEqual(["/d page_view"]);
  }
});

it("without the attribute and without a detector the first hit leaves at once", async () => {
  const p = gated(undefined, [["consent", "default", denied]]);
  expect(p.names()).toEqual(["/d page_view"]);
  expect(p.hits()[0]!.params).not.toHaveProperty("traffic_class");
  expect(p.delays()).toEqual([2000]);
});

it("polls the global a bounded number of times while it waits", async () => {
  const p = gated("1000", [["consent", "default", denied]]);
  await settle();
  // A snapshot set without any dataLayer push is still found by the poll.
  let polls = 0;
  while (p.fire(50)) polls++;
  expect(polls).toBe(20);
  expect(p.hits()).toHaveLength(0);
  const q = gated("1000", [["consent", "default", denied]]);
  await settle();
  q.host.__visitorVerdict = snapshot("declared_agent");
  expect(q.fire(50)).toBe(1);
  expect(q.names()).toEqual(["/d page_view"]);
  expect(q.hits()[0]!.params).toMatchObject({ traffic_class: "declared_agent" });
  // The poll ends once released.
  expect(q.fire(50)).toBe(0);
});

it("a detector with a custom dataLayer name releases from its own layer", async () => {
  const p = gated("1000", [["consent", "default", denied]], {
    setup: (host) => {
      host.visitorVerdictConfig = { dataLayerName: "vvLayer" };
      host.vvLayer = [];
    },
  });
  await settle();
  expect(p.hits()).toHaveLength(0);
  const layer = p.host.vvLayer as unknown[];
  p.host.__visitorVerdict = snapshot("automated");
  // The push still behaves like the original one.
  expect(layer.push({ event: "traffic_class", traffic_class: "automated" })).toBe(1);
  expect(layer).toHaveLength(1);
  expect(p.names()).toEqual(["/d page_view"]);
  expect(p.hits()[0]!.params).toMatchObject({ traffic_class: "automated" });
  // A layer the detector creates only later is covered by the poll.
  const q = gated("1000", [["consent", "default", denied]], {
    setup: (host) => {
      host.visitorVerdictConfig = { dataLayerName: "lateLayer" };
    },
  });
  await settle();
  q.publish("human", "initial", "lateLayer");
  expect(q.hits()).toHaveLength(0);
  q.fire(50);
  expect(q.names()).toEqual(["/d page_view"]);
  expect(q.hits()[0]!.params).toMatchObject({ traffic_class: "human" });
});

it("a configuration or layer that throws only leaves the deadline", async () => {
  const p = gated("1000", [["consent", "default", denied]], {
    setup: (host) => {
      Object.defineProperty(host, "visitorVerdictConfig", {
        get() {
          throw new Error("hostile");
        },
      });
    },
  });
  await settle();
  expect(p.hits()).toHaveLength(0);
  p.fire(1000);
  expect(p.names()).toEqual(["/d page_view"]);
  expect(p.warnings).not.toHaveBeenCalled();
});

it("a throwing global never releases early and never stops the hits", async () => {
  const p = gated("1000", [["consent", "default", denied]], {
    setup: (host) => {
      Object.defineProperty(host, "__visitorVerdict", {
        get() {
          throw new Error("hostile");
        },
      });
    },
  });
  await settle();
  p.host.dataLayer.push({ event: "traffic_class", traffic_class: "automated" });
  while (p.fire(50));
  expect(p.hits()).toHaveLength(0);
  p.fire(1000);
  expect(p.names()).toEqual(["/d page_view"]);
  expect(p.hits()[0]!.params).not.toHaveProperty("traffic_class");
  expect(p.warnings).not.toHaveBeenCalledWith(expect.stringContaining("Invalid event"));
});

it("a grant during the wait never releases the stale denied page view", async () => {
  const p = gated("1000", [["consent", "default", denied]]);
  await settle();
  p.command("event", "generate_lead", { value: 1 });
  p.command("consent", "update", granted);
  await settle();
  expect(p.hits()).toHaveLength(0);
  // The deadline that already runs is not restarted by the consent change.
  expect(p.delays().filter((ms) => ms === 1000)).toHaveLength(1);
  p.publish("automated");
  await settle();
  // The pre-choice event leaves only as a full event with the visitor's grant.
  expect(p.names()).toEqual(["/e page_view", "/e generate_lead"]);
  for (const hit of p.hits()) {
    expect(hit.consent?.analytics_storage).toBe("granted");
    expect(hit.params).toMatchObject({ traffic_class: "automated" });
  }
});

it("a refusal during the wait deletes at once and sends the denied page view instead", async () => {
  const p = gated("1000", [["consent", "default", granted]]);
  await settle();
  expect(p.hits()).toHaveLength(0);
  p.command("consent", "update", denied);
  // The deletion request is never held.
  expect(p.names()).toEqual(["/p"]);
  await settle();
  p.publish("automated");
  expect(p.names()).toEqual(["/p", "/d page_view"]);
  const ping = p.hits()[1]!;
  expect(ping.consent?.analytics_storage).toBe("denied");
  expect(ping.params).toMatchObject({ traffic_class: "automated" });
});

it("the deadline starts only when the hit is otherwise eligible and never extends wait_for_update", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.now();
  const p = gated("300", [["consent", "default", { ...denied, wait_for_update: 500 }]]);
  await settle();
  // Only the existing consent wake-up is scheduled before the consent wait is over.
  expect(p.delays()).toContain(500);
  expect(p.delays()).not.toContain(300);
  vi.setSystemTime(start + 500);
  p.fire(500);
  await settle();
  expect(p.hits()).toHaveLength(0);
  expect(p.delays().filter((ms) => ms === 300)).toHaveLength(1);
  vi.setSystemTime(start + 800);
  p.fire(300);
  expect(p.names()).toEqual(["/d page_view"]);
});

it("with no consent signal the gate never starts and pagehide sends nothing", async () => {
  const p = gated("1000");
  p.command("event", "generate_lead", { value: 1 });
  await settle();
  leave(p, "pagehide");
  await settle();
  expect(p.hits()).toHaveLength(0);
  expect(p.delays()).not.toContain(1000);
});

it("the deadline and a publication release once, even when they meet in a pending request", async () => {
  let answer: (response: Response) => void = () => {};
  const p = gated("1000", [["consent", "default", granted]]);
  p.fetcher.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
  );
  p.command("event", "generate_lead", { value: 1 });
  await settle();
  p.fire(1000);
  expect(p.names()).toEqual(["/e page_view"]);
  // The publication arrives while the page view is still on its way.
  p.publish("automated");
  p.fire(50);
  p.tick();
  await settle();
  expect(p.names()).toEqual(["/e page_view"]);
  answer(new Response(null, { status: 204 }));
  await settle();
  answer(new Response(null, { status: 204 }));
  await settle();
  expect(p.names()).toEqual(["/e page_view", "/e generate_lead"]);
  expect(p.hits()[1]!.params).toMatchObject({ traffic_class: "automated" });
});

it("a dataLayer push made while the detector's push releases is counted once", async () => {
  const p = gated("1000", [["consent", "default", denied]]);
  await settle();
  // Like GTM: a listener wrapped around the tracker's push reacts to the class with its own event.
  const inner = p.host.dataLayer.push;
  p.host.dataLayer.push = function (...items: unknown[]) {
    const result = inner.apply(this, items);
    for (const item of items)
      if ((item as { event?: string }).event === "traffic_class")
        p.host.dataLayer.push({ event: "generate_lead", value: 1 });
    return result;
  };
  p.publish("automated");
  await settle();
  expect(p.names()).toEqual(["/d page_view", "/d generate_lead"]);
  expect(p.hits().map((hit) => hit.hit_index)).toEqual([1, 2]);
  for (const hit of p.hits()) expect(hit.params).toMatchObject({ traffic_class: "automated" });
  p.fire(1000);
  p.fire(50);
  p.tick();
  await settle();
  expect(p.hits()).toHaveLength(2);
});

for (const kind of ["pagehide", "hidden"] as const) {
  it(`${kind} before the deadline sends the held denied pings synchronously`, async () => {
    const p = gated("1000", [["consent", "default", denied]]);
    p.command("event", "generate_lead", { value: 1 });
    await settle();
    expect(p.hits()).toHaveLength(0);
    // Published without a push the tracker heard: the class is read at the actual send.
    p.host.__visitorVerdict = snapshot("suspicious");
    leave(p, kind);
    expect(p.names()).toEqual(["/d page_view", "/d generate_lead"]);
    for (const hit of p.hits()) {
      expect(hit.init).toMatchObject({ keepalive: true, credentials: "omit" });
      expect(hit.params).toMatchObject({ traffic_class: "suspicious" });
    }
    p.fire(1000);
    await settle();
    expect(p.hits()).toHaveLength(2);
  });

  it(`${kind} before the deadline sends the held page view before the exit hit`, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const p = gated("1000", [["consent", "default", granted]]);
    await settle();
    vi.setSystemTime(start + 400);
    leave(p, kind);
    // Synchronously, before any response.
    expect(p.names()).toEqual(["/e page_view", "/e page_engagement"]);
    expect(p.hits()[0]!.init).toMatchObject({ keepalive: true, credentials: "include" });
    expect(p.hits()[0]!.timestamp_ms).toBe(start);
    expect(p.hits()[1]!.params).toMatchObject({ engagement_time_msec: 400 });
    p.fire(1000);
    await settle();
    expect(p.names()).toEqual(["/e page_view", "/e page_engagement"]);
  });
}

it("SPA navigation first sends the held hits of the page being left", async () => {
  const p = gated("1000", [["consent", "default", denied]]);
  await settle();
  const first = p.host.location as { href: string };
  const landing = first.href;
  p.host.history.pushState({}, "", "https://shop.example/b");
  const hits = p.hits();
  expect(p.names()).toEqual(["/d page_view", "/d page_view"]);
  expect(hits[0]!.params!.page_location).toBe(landing.replace("email=private&", ""));
  expect(hits[1]!.params!.page_location).toBe("https://shop.example/b");
  // A new denied page identity, sent without a second wait: the gate is per document.
  expect(hits[0]!.page_id).not.toBe(hits[1]!.page_id);
  expect(p.delays().filter((ms) => ms === 1000)).toHaveLength(1);
});

it("SPA navigation with consent sends old page view, its exit, then the new page view", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.now();
  const p = gated("1000", [["consent", "default", granted]]);
  await settle();
  vi.setSystemTime(start + 300);
  p.host.history.pushState({}, "", "https://shop.example/b");
  await settle();
  const hits = p.hits();
  expect(p.names()).toEqual(["/e page_view", "/e page_engagement", "/e page_view"]);
  expect(hits[0]!.params!.page_location).toBe("https://shop.example/?utm_source=test");
  expect(hits[2]!.params!.page_location).toBe("https://shop.example/b");
  expect(new Set(hits.map((hit) => hit.client_id)).size).toBe(1);
  p.fire(1000);
  await settle();
  expect(p.hits()).toHaveLength(3);
});

it("a back/forward cache restore sends only its page view, with the current class and no wait", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const p = gated("1000", [["consent", "default", granted]]);
  await settle();
  vi.setSystemTime(Date.now() + 200);
  leave(p, "pagehide");
  await settle();
  expect(p.names()).toEqual(["/e page_view", "/e page_engagement"]);
  vi.setSystemTime(Date.now() + 60_000);
  p.host.__visitorVerdict = snapshot("human", "final");
  p.host.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
  await settle();
  expect(p.names()).toEqual(["/e page_view", "/e page_engagement", "/e page_view"]);
  expect(p.hits()[2]!.params).toMatchObject({ traffic_class: "human", traffic_phase: "final" });
  // The old deadline is stale and changes nothing after the restore.
  p.fire(1000);
  p.tick();
  await settle();
  expect(p.hits()).toHaveLength(3);
  expect(p.delays().filter((ms) => ms === 1000)).toHaveLength(1);
});

it("a denied restore reads the current consent and sends one new page view ping", async () => {
  const p = gated("1000", [["consent", "default", denied]]);
  await settle();
  p.publish("automated");
  expect(p.names()).toEqual(["/d page_view"]);
  leave(p, "pagehide");
  p.host.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
  const hits = p.hits();
  expect(p.names()).toEqual(["/d page_view", "/d page_view"]);
  expect(hits[0]!.page_id).not.toBe(hits[1]!.page_id);
  expect(hits[1]!.params).toMatchObject({ traffic_class: "automated" });
});

it("a restore without a pagehide still sends the held page view before its identity is reset", async () => {
  const p = gated("1000", [["consent", "default", denied]]);
  await settle();
  expect(p.hits()).toHaveLength(0);
  p.host.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
  const hits = p.hits();
  expect(p.names()).toEqual(["/d page_view", "/d page_view"]);
  expect(hits[0]!.page_id).not.toBe(hits[1]!.page_id);
});

it("a class published while the tracker subscribes is found by the check after subscribing", async () => {
  const p = gated("1000", [["consent", "default", denied]], {
    setup: (host) => {
      // Read only while subscribing; the detector publishes at that very moment.
      Object.defineProperty(host, "visitorVerdictConfig", {
        get() {
          host.__visitorVerdict = snapshot("automated");
          return { dataLayerName: "dataLayer" };
        },
      });
    },
  });
  expect(p.names()).toEqual(["/d page_view"]);
  expect(p.hits()[0]!.params).toMatchObject({ traffic_class: "automated" });
});

it("pagehide sends the first held full event at once; the next follow the existing queue", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const answers: ((response: Response) => void)[] = [];
  const p = gated("1000", [["consent", "default", granted]]);
  p.fetcher.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        answers.push(resolve);
      }),
  );
  p.command("event", "generate_lead", { value: 1 });
  await settle();
  vi.setSystemTime(Date.now() + 300);
  leave(p, "pagehide");
  // The page view, which may open the session, leaves synchronously, then the exit hit, which
  // never waits for the queue; the held event follows the page view's response, as today.
  expect(p.names()).toEqual(["/e page_view", "/e page_engagement"]);
  answers[0]!(new Response(null, { status: 204 }));
  await settle();
  expect(p.names()).toEqual(["/e page_view", "/e page_engagement", "/e generate_lead"]);
});
