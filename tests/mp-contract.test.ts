import { afterEach, expect, it, vi } from "vitest";
import { validateParams, validEventName } from "../src/server/mp-validation.js";
import { shortenBytes } from "../src/shared/event.js";
import { buildEventCollectUrl, collectRequest, sendGoogle } from "../src/server/google.js";
import { deviceModel, deviceBrowser } from "../src/client/device.js";
import { normalizeConsent } from "../src/shared/consent.js";
import { createTracker } from "../src/client/tracker.js";
import { page } from "./browser-fixture.js";
const destination = { measurementId: "G-TEST" };
const granted = normalizeConsent({ analytics_storage: "granted" });
const event = () => {
  const now = Date.now();
  return {
    event_id: crypto.randomUUID(),
    name: "page_engagement",
    client_id: "1.2",
    session_id: 123,
    session_started_ms: now,
    session_expires_ms: now + 1800000,
    timestamp_ms: now,
    consent: granted,
    params: {},
  };
};
afterEach(() => vi.useRealTimers());
it("final automatic parameters take precedence, page text keeps 256 bytes, other strings are cut to 100 characters", () => {
  const warn = vi.fn();
  const params = validateParams(
    {
      ...Object.fromEntries(Array.from({ length: 26 }, (_, i) => ["field_" + i, i])),
      session_id: 123,
      engagement_time_msec: 1200,
      page_location: "x".repeat(300),
      page_referrer: "r".repeat(300),
      page_title: "😀".repeat(101),
    },
    warn,
  );
  expect(Object.keys(params)).toHaveLength(25);
  expect(params).toMatchObject({
    session_id: 123,
    engagement_time_msec: 1200,
    page_location: "x".repeat(256),
    page_referrer: "r".repeat(256),
    page_title: "😀".repeat(64),
  });
  expect(warn).toHaveBeenCalled();
  const invalid = validateParams(
    {
      "bad-name": "x",
      ["n".repeat(41)]: "x",
      _private: 1,
      firebase_conversion: 1,
      google_value: 1,
      ga_value: 1,
      firebase_value: 1,
      long: "č".repeat(101),
      emoji: "😀".repeat(150),
      nested: { x: 1 },
      valid: "x".repeat(100),
    },
    warn,
  );
  expect(invalid).toEqual({
    long: "č".repeat(100),
    emoji: "😀".repeat(100),
    valid: "x".repeat(100),
  });
  expect(warn).toHaveBeenCalledWith("Event parameter truncated to 100 characters");
  const itemWarn = vi.fn();
  const [item] = validateParams(
    {
      items: [
        { item_name: "n".repeat(150), item_brand: "b".repeat(100), custom_long: "v".repeat(120) },
      ],
    },
    itemWarn,
  ).items as Record<string, unknown>[];
  expect(item).toEqual({
    item_name: "n".repeat(100),
    item_brand: "b".repeat(100),
    custom_long: "v".repeat(100),
  });
  expect(itemWarn).toHaveBeenCalledTimes(2);
  expect(itemWarn).toHaveBeenCalledWith("Event item parameter truncated to 100 characters");
});
it("page text is cut by UTF-8 bytes on whole characters and never ends in a partial percent escape", () => {
  const params = validateParams(
    {
      page_title: "č".repeat(200),
      page_location: "https://shop.example/" + "a".repeat(233) + "%C4%8D",
      page_referrer: "x".repeat(256),
    },
    vi.fn(),
  );
  expect(params.page_title).toBe("č".repeat(128));
  expect(params.page_location).toBe("https://shop.example/" + "a".repeat(233));
  expect(params.page_referrer).toBe("x".repeat(256));
  expect(shortenBytes("ab%C", 3)).toBe("ab");
  expect(shortenBytes("ab%", 2)).toBe("ab");
});
it("ecommerce items retain standard fields plus 27 custom parameters", () => {
  const custom = Object.fromEntries(Array.from({ length: 28 }, (_, i) => [`custom_${i}`, i]));
  const params = validateParams({
    items: [{ item_id: "sku", item_name: "Boot", price: 10, quantity: 2, ...custom }],
  });
  const item = (params.items as Record<string, unknown>[])[0]!;
  expect(item).toMatchObject({ item_id: "sku", item_name: "Boot", price: 10, quantity: 2 });
  expect(Object.keys(item).filter((key) => key.startsWith("custom_"))).toHaveLength(27);
});
it("reserved events are rejected; custom page engagement and measured time are valid", () => {
  expect(validEventName("user_engagement")).toBe(false);
  expect(validEventName("session_start")).toBe(false);
  const e = { ...event(), params: { engagement_time_msec: 1200, session_id: 999 } };
  const request = buildEventCollectUrl(destination, e, granted)!;
  expect(request.searchParams.get("en")).toBe("page_engagement");
  expect(request.searchParams.get("sid")).toBe("123");
  expect(request.searchParams.get("_et")).toBe("1200");
});
it("device model uses available browser hints with generic fallbacks", () => {
  expect(deviceModel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)")).toBe("iPhone");
  expect(deviceModel("Mozilla/5.0 (Linux; Android 14; Pixel 9 Pro Build/123)")).toBe("Pixel 9 Pro");
  expect(deviceModel("Mozilla/5.0 (Windows NT 10.0)")).toBe("Windows PC");
  expect(deviceModel("")).toBe("Desktop");
});
for (const [status, expected] of [
  [204, "sent"],
  [400, "dropped"],
  [401, "dropped"],
  [403, "dropped"],
  [404, "dropped"],
  [413, "dropped"],
  [429, "retry"],
  [500, "retry"],
  [503, "retry"],
] as const) {
  it(`Google HTTP ${status} is ${expected}`, async () => {
    expect(
      await sendGoogle(
        destination,
        event(),
        () => granted,
        new AbortController().signal,
        vi.fn<typeof fetch>(async () => new Response(null, { status })),
      ),
    ).toBe(expected);
  });
}
it("network and timeout failures remain retryable", async () => {
  for (const error of [new TypeError("offline"), new DOMException("timeout", "TimeoutError")]) {
    expect(
      await sendGoogle(
        destination,
        event(),
        () => granted,
        new AbortController().signal,
        vi.fn<typeof fetch>(async () => {
          throw error;
        }),
      ),
    ).toBe("retry");
  }
});
it("keepalive byte guard counts UTF-8, not UTF-16 characters", async () => {
  const p = page([["consent", "update", granted]]);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  // 68 KB in UTF-8, 34,000 UTF-16 code units.
  p.command("event", "generate_lead", { note: "😀".repeat(17000) });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(p.fetcher).toHaveBeenCalledTimes(1);
  expect(p.warnings).toHaveBeenCalledWith(expect.stringContaining("UTF-8"));
});
it("visible time during wait_for_update counts once the grant takes effect", async () => {
  vi.useFakeTimers();
  const p = page([["consent", "default", { ...granted, wait_for_update: 1000 }]]);
  vi.advanceTimersByTime(1000);
  (p.host.setInterval.mock.calls[0]![0] as () => void)();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const first = JSON.parse(String(p.fetcher.mock.calls[0]![1]?.body));
  expect(first.params.engagement_time_msec).toBe(0);
  vi.advanceTimersByTime(250);
  p.host.dispatchEvent(new Event("pagehide"));
  const exit = JSON.parse(String(p.fetcher.mock.calls.at(-1)![1]?.body));
  expect(exit.name).toBe("page_engagement");
  expect(exit.params.engagement_time_msec).toBe(1250);
});
const exitTime = async (p: ReturnType<typeof page>) => {
  p.host.dispatchEvent(new Event("pagehide"));
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const sent = p.fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body ?? "{}")));
  return sent.filter((event) => event.name === "page_engagement").at(-1)?.params
    .engagement_time_msec;
};
it("time before the decision is sent after a grant, like the Google tag", async () => {
  vi.useFakeTimers();
  const p = page();
  vi.advanceTimersByTime(4000);
  p.command("consent", "update", granted);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  vi.advanceTimersByTime(1000);
  await exitTime(p);
  const sent = p.fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body ?? "{}")));
  const time = (name: string) =>
    sent.filter((e) => e.name === name).map((e) => e.params.engagement_time_msec);
  // The opening page view, released by the grant, carries the time before it.
  expect(time("page_view")).toEqual([4000]);
  expect(time("page_engagement")).toEqual([1000]);
});
it("a refusal discards earlier time and time while refused never counts", async () => {
  vi.useFakeTimers();
  const p = page();
  vi.advanceTimersByTime(4000);
  p.command("consent", "update", { analytics_storage: "denied" });
  (p.host.setInterval.mock.calls[0]![0] as () => void)();
  vi.advanceTimersByTime(2000);
  p.command("consent", "update", granted);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  vi.advanceTimersByTime(1000);
  expect(await exitTime(p)).toBe(1000);
});
it("a withdrawal stops the clock: nothing is reported after it", async () => {
  vi.useFakeTimers();
  const p = page([["consent", "update", granted]]);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  vi.advanceTimersByTime(3000);
  p.command("consent", "update", { analytics_storage: "denied" });
  (p.host.setInterval.mock.calls[0]![0] as () => void)();
  const before = p.fetcher.mock.calls.length;
  vi.advanceTimersByTime(3000);
  p.host.dispatchEvent(new Event("pagehide"));
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const later = p.fetcher.mock.calls.slice(before).map(([url]) => new URL(String(url)).pathname);
  expect(later.filter((path) => path === "/e")).toEqual([]);
});

it("browser family detection distinguishes shared engine signatures and provides a fallback", () => {
  for (const [agent, browser] of [
    ["Mozilla/5.0 Chrome/130.0 Safari/537.36 Edg/130.0", "Edge"],
    ["Mozilla/5.0 Chrome/130.0 Safari/537.36 OPR/115.0", "Opera"],
    ["Mozilla/5.0 SamsungBrowser/26.0 Chrome/130.0 Safari/537.36", "Samsung Internet"],
    ["Mozilla/5.0 Firefox/130.0", "Firefox"],
    ["Mozilla/5.0 Chrome/130.0 Safari/537.36", "Chrome"],
    ["Mozilla/5.0 Version/18.0 Safari/605.1", "Safari"],
    ["Mozilla/5.0 CriOS/130.0 Mobile Safari/604.1", "Chrome"],
    ["Mozilla/5.0 FxiOS/130.0 Mobile Safari/605.1", "Firefox"],
    ["Mozilla/5.0 EdgiOS/130.0 Mobile Safari/605.1", "Edge"],
    ["", "Unknown"],
    ["unrecognized browser", "Unknown"],
  ])
    expect(deviceBrowser(agent!)).toBe(browser);
});
it("browser entry sends a detected browser family in its device object", async () => {
  const p = page([["consent", "update", granted]]);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(JSON.parse(String(p.fetcher.mock.calls[0]![1]?.body)).device.browser).toBe("Unknown");
  p.host.navigator.userAgent = "Mozilla/5.0 Chrome/130.0 Safari/537.36";
  p.command("event", "generate_lead");
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(JSON.parse(String(p.fetcher.mock.calls.at(-1)![1]?.body)).device.browser).toBe("Chrome");
});

it("the exit event cuts page text like the collector: bytes, whole characters, no dangling escape", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const href = "https://x.example/?utm_source=" + "a".repeat(224) + "%C3%A1";
  const tracker = createTracker(
    "https://collector.example/e",
    {
      href: () => href,
      referrer: () => "",
      title: () => "😀".repeat(100),
      now: () => Date.now(),
      uuid: () => crypto.randomUUID(),
      fetch: fetcher,
      warn: vi.fn(),
    },
    new Set(),
  );
  tracker.update({ analytics_storage: "granted" });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  tracker.exit(100);
  const exit = JSON.parse(String(fetcher.mock.calls.at(-1)![1]!.body));
  expect(exit.name).toBe("page_engagement");
  expect(exit.params.page_location).toBe(href.slice(0, 254));
  expect(exit.params.page_title).toBe("😀".repeat(64));
});

it("purchase fields use exact collect types and item prefixes", () => {
  const url = buildEventCollectUrl(
    destination,
    {
      ...event(),
      name: "purchase",
      params: {
        currency: "CZK",
        value: 1990,
        tax: 0,
        shipping: 50,
        transaction_id: "001",
        coupon: "SAVE",
        numeric_text: "42",
        number: 42,
        items: [
          {
            item_id: "VT1",
            item_name: "Vanilla test",
            price: 1990,
            quantity: 1,
            item_brand: "Vanilla",
            item_category: "A",
            item_category2: "B",
            item_category3: "C",
            item_category4: "D",
            item_category5: "E",
            item_variant: "V",
            item_list_name: "List",
            item_list_id: "L1",
            index: 0,
            affiliation: "Shop",
            coupon: "C",
            discount: 0,
            location_id: "CZ",
            custom: "červená",
            score: 0,
          },
        ],
      },
    },
    granted,
  )!;
  expect(url.pathname).toBe("/g/collect");
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    en: "purchase",
    cu: "CZK",
    "epn.value": "1990",
    "epn.tax": "0",
    "epn.shipping": "50",
    "ep.transaction_id": "001",
    "ep.coupon": "SAVE",
    "ep.numeric_text": "42",
    "epn.number": "42",
    pr1: "idVT1~nmVanilla test~pr1990~qt1~brVanilla~caA~c2B~c3C~c4D~c5E~vaV~lnList~liL1~lp0~afShop~cpC~ds0~loCZ~k0custom~v0červená~k1score~v10",
  });
});
it("item tildes cannot inject fields and Unicode survives outer encoding", () => {
  const url = buildEventCollectUrl(
    destination,
    { ...event(), params: { items: [{ item_name: "Příliš~qt999", custom: "ž~luť~" }] } },
    granted,
  )!;
  const item = new URL(url.href).searchParams.get("pr1")!;
  // Same escape as the Google tag: a doubled tilde is a literal one.
  expect(item).toBe("nmPříliš~~qt999~k0custom~v0ž~~luť~~");
  expect(item.match(/(?:[^~]|~~)+/g)).toEqual(["nmPříliš~~qt999", "k0custom", "v0ž~~luť~~"]);
});
it("engagement and subsequent page views set seg, with page sequence passed through", () => {
  for (const [name, engagement, start, expected] of [
    ["page_view", 0, true, "0"],
    ["page_view", 0, false, "1"],
    ["purchase", 9999, false, "0"],
    ["page_engagement", 10000, false, "1"],
  ] as const) {
    const url = buildEventCollectUrl(
      destination,
      {
        ...event(),
        name,
        page_id: "123456",
        hit_index: 3,
        params: { engagement_time_msec: engagement },
      },
      granted,
      { sessionStart: start, firstVisit: false },
    )!;
    expect(url.searchParams.get("seg")).toBe(expected);
    expect(url.searchParams.get("_p")).toBe("123456");
    expect(url.searchParams.get("_s")).toBe("3");
  }
});
it("a large purchase goes in the body like the Google tag, an oversized one keeps the first items", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const google = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const purchase = (items: Record<string, unknown>[]) =>
    sendGoogle(
      destination,
      { ...event(), name: "purchase", params: { transaction_id: "T1", value: 1, items } },
      () => granted,
      new AbortController().signal,
      google,
    );
  try {
    const big = Array.from({ length: 100 }, (_, i) => ({
      item_id: `sku${i}`,
      item_name: `Jablka Golden Delicious ${i} kg bedna`,
    }));
    expect(await purchase(big)).toBe("sent");
    const [target, init] = google.mock.calls[0]!;
    const url = new URL(String(target));
    expect(Buffer.byteLength(url.href)).toBeLessThan(2000);
    expect(url.searchParams.get("cid")).toBeTruthy();
    expect(url.searchParams.get("en")).toBeNull();
    const body = new URLSearchParams(String(init!.body));
    expect(String(init!.body)).not.toContain("\n");
    expect(body.get("en")).toBe("purchase");
    expect(body.get("ep.transaction_id")).toBe("T1");
    expect(body.get("pr100")).toBe("idsku99~nmJablka Golden Delicious 99 kg bedna");
    expect(warn).not.toHaveBeenCalled();

    google.mockClear();
    const long = big.map((item) => ({ ...item, item_name: "č".repeat(80) }));
    expect(await purchase(long)).toBe("sent");
    const trimmed = String(google.mock.calls[0]![1]!.body);
    expect(Buffer.byteLength(trimmed)).toBeLessThanOrEqual(16 * 1024);
    const kept = new URLSearchParams(trimmed);
    expect(kept.get("ep.transaction_id")).toBe("T1");
    expect(kept.get("epn.value")).toBe("1");
    expect(kept.get("pr1")).toBe(`idsku0~nm${"č".repeat(80)}`);
    expect(kept.get("pr100")).toBeNull();
    const count = [...kept.keys()].filter((key) => /^pr\d+$/.test(key)).length;
    expect(count).toBeGreaterThan(20);
    expect(warn).toHaveBeenCalledWith(
      `Collect event trimmed: ${100 - count} items left out to fit 16 KiB`,
    );

    google.mockClear();
    const small = await purchase([{ item_id: "a", item_name: "b" }]);
    expect(small).toBe("sent");
    expect(google.mock.calls[0]![1]!.body).toBeUndefined();
    expect(new URL(String(google.mock.calls[0]![0])).searchParams.get("pr1")).toBe("ida~nmb");

    const huge = new URL("https://region1.google-analytics.com/g/collect?v=2&en=x");
    for (let i = 0; i < 30; i++) huge.searchParams.set(`ep.p${i}`, "č".repeat(100));
    expect(collectRequest(huge)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "Collect event dropped: encoded event exceeds 16 KiB without items",
    );
  } finally {
    warn.mockRestore();
  }
});
it("all delivered events use collect, analytics-only removes clicks and sets npa", async () => {
  const google = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  for (const name of ["page_view", "purchase", "generate_lead", "page_engagement"]) {
    await sendGoogle(
      destination,
      {
        ...event(),
        name,
        click_ids: { gclid: "SECRET" },
        params: { page_location: "https://shop.example/?gclid=SECRET", gclid: "SECRET" },
      },
      () => granted,
      new AbortController().signal,
      google,
    );
  }
  expect(google).toHaveBeenCalledTimes(4);
  for (const [input, init] of google.mock.calls) {
    const url = new URL(String(input));
    expect(url.pathname).toBe("/g/collect");
    expect(url.searchParams.get("npa")).toBe("1");
    expect(url.href).not.toContain("SECRET");
    expect(init?.method).toBe("POST");
  }
});
it("tracker keeps a page ID and increments hit indices across SPA boundaries", async () => {
  const google = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const tracker = createTracker(
    "https://collector.example/e",
    {
      href: () => "https://shop.example/",
      referrer: () => "",
      now: () => Date.now(),
      uuid: () => crypto.randomUUID(),
      fetch: google,
      warn: vi.fn(),
    },
    new Set(["purchase"]),
  );
  tracker.update(granted);
  await tracker.flush();
  tracker.track("purchase");
  await tracker.flush();
  tracker.exit(1200);
  tracker.page();
  await tracker.flush();
  const hits = google.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  expect(hits.map((hit) => hit.hit_index)).toEqual([1, 2, 3, 1]);
  expect(hits.slice(0, 3).every((hit) => hit.page_id === hits[0].page_id)).toBe(true);
  expect(hits[3].page_id).not.toBe(hits[0].page_id);
});

it("retries preserve page and hit identifiers", async () => {
  let now = Date.now();
  const google = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValue(new Response(null, { status: 204 }));
  const tracker = createTracker(
    "https://collector.example/e",
    {
      href: () => "https://shop.example/",
      referrer: () => "",
      now: () => now,
      uuid: () => crypto.randomUUID(),
      fetch: google,
      warn: vi.fn(),
    },
    new Set(),
  );
  tracker.update(granted);
  await tracker.flush();
  now += 1000;
  await tracker.flush();
  expect(google).toHaveBeenCalledTimes(2);
  const hits = google.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  expect(hits[1].page_id).toBe(hits[0].page_id);
  expect(hits.map((hit) => hit.hit_index)).toEqual([1, 1]);
});
it("money sent as text still counts as a number, other numeric text stays text", () => {
  const url = buildEventCollectUrl(
    destination,
    {
      ...event(),
      name: "generate_lead",
      params: { currency: "CZK", value: "500", shipping: "49.5", tax: "n/a", lead_id: "500" },
    },
    granted,
  )!;
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    "epn.value": "500",
    "epn.shipping": "49.5",
    "ep.tax": "n/a",
    "ep.lead_id": "500",
  });
});
it("every hit keeps a long campaign URL, not only the one opening the session", () => {
  const landing = "https://shop.example/?utm_campaign=" + "c".repeat(600);
  const url = buildEventCollectUrl(
    destination,
    { ...event(), name: "add_to_cart", params: { page_location: landing } },
    granted,
  )!;
  expect(url.searchParams.get("dl")).toBe(landing);
});
