import { expect, it, vi } from "vitest";
import { createTracker } from "../src/client/tracker.js";
import { createApp } from "../src/server/app.js";
import { page } from "./browser-fixture.js";

const denied = { analytics_storage: "denied", ad_storage: "granted", ad_user_data: "granted" };
const granted = { ...denied, analytics_storage: "granted" };
function fixture(pings = true, status = 204) {
  let now = Date.now();
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status }));
  const tracker = createTracker(
    "https://collector.test/e",
    {
      now: () => now,
      uuid: () => crypto.randomUUID(),
      href: () => "https://shop.test/?gclid=secret",
      referrer: () => "",
      warn: () => {},
      fetch: fetcher,
    },
    new Set(["view_item", "purchase", "generate_lead"]),
    false,
    pings,
  );
  const hits = (path = "/d") =>
    fetcher.mock.calls
      .filter(([u]) => new URL(String(u)).pathname === path)
      .map(([, init]) => JSON.parse(String(init?.body)));
  return {
    tracker,
    hits,
    advance: async (ms: number) => {
      now += ms;
      await tracker.flush();
    },
  };
}
it("an undecided readable banner pings immediately and later grants release full purchases", async () => {
  const { tracker, hits, advance } = fixture();
  tracker.track("view_item", { value: 100 });
  expect(hits()).toEqual([]);
  tracker.update({}, 2000, false, false, true);
  expect(hits().map((e) => e.name)).toEqual(["page_view", "view_item"]);
  tracker.track("purchase", {
    transaction_id: "tx",
    user_data: { email: "private" },
    gclid: "secret",
  });
  tracker.track("purchase", { transaction_id: "tx" });
  expect(hits().map((e) => e.name)).toEqual(["page_view", "view_item", "purchase"]);
  expect(JSON.stringify(hits().map((e) => e.params))).not.toMatch(/secret|private|user_data|gclid/);
  expect(hits()[0].consent.analytics_storage).toBe("denied");
  tracker.update(granted);
  await advance(0);
  expect(hits("/e").map((e) => e.name)).toEqual(["page_view", "view_item", "purchase"]);
  expect(hits("/e")[2].params.user_data).toEqual({ email: "private" });
});
it.each([0, 725, 2000, 5000])(
  "a default waits exactly its bounded wait_for_update: %i",
  async (ms) => {
    const { tracker, hits, advance } = fixture(true, 503);
    tracker.update(denied, ms, false, false);
    tracker.track("view_item");
    const delay = Math.min(ms, 2000);
    if (delay) {
      expect(hits()).toEqual([]);
      await advance(delay - 1);
      expect(hits()).toEqual([]);
      await advance(1);
    }
    expect(hits().map((e) => e.name)).toEqual(["page_view", "view_item"]);
    await advance(10_000);
    expect(hits()).toHaveLength(2); // Failed pings are never retried.
  },
);
it("refusal drops the full queue, but subsequent allowed events still ping", async () => {
  const { tracker, hits, advance } = fixture();
  tracker.update(denied, 0, false, false);
  tracker.track("view_item");
  tracker.update(denied, 0, true, true);
  tracker.track("purchase", { transaction_id: "refused" });
  tracker.track("purchase", { transaction_id: "refused" });
  tracker.track("page_engagement");
  expect(tracker.pending()).toBe(0);
  expect(hits().map((e) => e.name)).toEqual(["page_view", "view_item", "purchase"]);
  tracker.update(granted);
  await advance(0);
  expect(hits("/e").map((e) => e.name)).toEqual(["page_view"]);
});
it("a measured page stays unpinged after withdrawal, including later custom events", async () => {
  const { tracker, hits, advance } = fixture();
  tracker.update(granted);
  await advance(0);
  tracker.update(denied);
  tracker.track("view_item");
  expect(hits()).toEqual([]);
});
it("off suppresses every event ping", () => {
  const { tracker, hits } = fixture(false);
  tracker.update(denied);
  tracker.track("purchase", { transaction_id: "off" });
  expect(hits()).toEqual([]);
});
it("a banner becoming readable cancels ping waiting even when effective consent stays denied", () => {
  const { tracker, hits } = fixture();
  tracker.update(denied, 2000, false, false);
  tracker.track("view_item");
  tracker.update(denied, 1900, false, false, true);
  expect(hits().map((e) => e.name)).toEqual(["page_view", "view_item"]);
});
it("observer exposes undecided banners and resets a default's omitted wait to zero", () => {
  const p = page([["consent", "default", { ...denied, wait_for_update: 2000 }]]);
  expect(p.fetcher).not.toHaveBeenCalled();
  p.command("consent", "default", denied);
  expect(p.fetcher.mock.calls.filter(([u]) => String(u).endsWith("/d"))).toHaveLength(1);
});
it("collector validates names, strips sensitive keys and uses ordinary ecommerce encoding", async () => {
  const google = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const app = createApp(
    { measurementId: "G-TEST", siteOrigin: "https://shop.test", cookieSecret: "s".repeat(64) },
    google,
  );
  const base = {
    name: "purchase",
    consent: denied,
    client_id: "123.456",
    session_id: 123,
    page_id: "123",
    hit_index: 2,
    params: {
      transaction_id: "tx",
      currency: "CZK",
      value: 100,
      user_data: "private",
      gclid: "secret",
      gbraid: "secret",
      wbraid: "secret",
      items: [{ item_id: "SKU1", price: 100, quantity: 1, user_data: "private", gclid: "secret" }],
    },
  };
  const post = (payload: object) =>
    app.inject({
      method: "POST",
      url: "/d",
      remoteAddress: "8.8.8.8",
      headers: {
        origin: "https://shop.test",
        "user-agent": "Mozilla/5.0",
        cookie: "vanilla_session=ignored",
      },
      payload,
    });
  try {
    const response = await post(base);
    expect(response.statusCode).toBe(204);
    expect(response.headers["set-cookie"]).toBeUndefined();
    const raw = String(google.mock.calls[0]![0]);
    const q = new URL(raw).searchParams;
    expect(q.get("_uip")).toBe("8.8.8.8");
    expect(q.get("gcs")).toBe("G110");
    expect(q.get("cu")).toBe("CZK");
    expect(q.get("epn.value")).toBe("100");
    expect(q.get("ep.transaction_id")).toBeNull();
    expect(q.get("pr1")).toBeNull();
    expect(raw).not.toMatch(/private|secret|user_data|gclid|gbraid|wbraid/);
    for (const name of ["page_engagement", "session_start", "not_allowed", "ga_custom"])
      expect((await post({ ...base, name })).statusCode).toBe(400);
    expect(
      (
        await post({
          ...base,
          params: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`p${i}`, i])),
        })
      ).statusCode,
    ).toBe(400);
    expect((await post({ ...base, params: { huge: "x".repeat(65536) } })).statusCode).toBe(413);
    expect(google).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});
it("wait_for_update wakes at its deadline without periodic polling", async () => {
  vi.useFakeTimers();
  try {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const tracker = createTracker(
      "https://collector.test/e",
      {
        now: Date.now,
        uuid: () => crypto.randomUUID(),
        href: () => "https://shop.test/",
        referrer: () => "",
        warn: () => {},
        fetch: fetcher,
        defer: (task, delay) => {
          setTimeout(task, delay);
        },
      },
      new Set(["view_item"]),
    );
    tracker.update(denied, 725, false, false);
    tracker.track("view_item");
    await vi.advanceTimersByTimeAsync(724);
    expect(fetcher).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).name)).toEqual([
      "page_view",
      "view_item",
    ]);
  } finally {
    vi.useRealTimers();
  }
});
