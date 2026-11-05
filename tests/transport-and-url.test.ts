import { expect, it, vi } from "vitest";
import type { TrackingEvent } from "../src/shared/event.js";
import { cleanUrls, sanitizeUrl } from "../src/shared/consent.js";
import { createTracker } from "../src/client/tracker.js";
import { createApp } from "../src/server/app.js";
import { page } from "./browser-fixture.js";

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const grant = {
  analytics_storage: "granted",
  ad_user_data: "granted",
  ad_personalization: "granted",
};
const dest = {
  cookieSecret: "s".repeat(64),
  measurementId: "G-TEST",
  apiSecret: "test",
  siteOrigin: "https://shop.example",
};

it("independent: purchase 503 -> ad denial -> ad regrant -> 204 keeps restrictive consent at Google", async () => {
  let now = Date.now();
  const google = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValue(new Response(null, { status: 204 }));
  const app = createApp(dest, google);
  const deliveries: TrackingEvent[] = [];
  const transport: typeof fetch = async (_url, options) => {
    if (String(_url).endsWith("/p")) return new Response(null, { status: 204 });
    deliveries.push(JSON.parse(String(options!.body)));
    const reply = await app.inject({
      method: "POST",
      url: "/e",
      headers: { origin: dest.siteOrigin, "content-type": "application/json" },
      payload: String(options!.body),
    });
    return new Response(null, { status: reply.statusCode });
  };
  const tracker = createTracker(
    "https://kx7qpa.example.com/e",
    {
      now: () => now,
      uuid: () => crypto.randomUUID(),

      href: () => dest.siteOrigin,
      referrer: () => "",
      warn: vi.fn(),
      fetch: transport,
    },
    new Set(["purchase"]),
  );
  try {
    tracker.update(grant);
    tracker.track("purchase", { transaction_id: "audit-retry" });
    // Await the real collector transport rather than only microtasks.
    await vi.waitFor(() => expect(google).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(tracker.pending()).toBe(1));
    tracker.update({ ...grant, ad_user_data: "denied" });
    tracker.update(grant);
    now += 2000;
    await tracker.flush();
    expect(deliveries).toHaveLength(3);
    expect(deliveries[2]!.consent.ad_user_data).toBe("denied");
    expect(deliveries[2]!.event_id).toBe(deliveries[1]!.event_id);
    expect(JSON.parse(String(google.mock.calls[2]![1]!.body)).consent).toEqual({
      ad_user_data: "DENIED",
      ad_personalization: "GRANTED",
    });
    expect(tracker.pending()).toBe(0);
    google.mockResolvedValue(new Response(null, { status: 503 }));
    tracker.track("purchase", { transaction_id: "audit-withdraw" });
    await vi.waitFor(() => expect(google).toHaveBeenCalledTimes(4));
    await settle();
    tracker.update({ analytics_storage: "denied" });
    now += 2000;
    await tracker.flush();
    expect(tracker.pending()).toBe(0);
    expect(google).toHaveBeenCalledTimes(4);
  } finally {
    await app.close();
  }
});

it("independent: URL variants retain only UTM, ordinary text stays unchanged", async () => {
  const p = page([["consent", "update", grant]]);
  await settle();
  for (const value of [
    " https://shop.example/a?email=secret&utm_source=a#secret",
    "a?email=secret&utm_source=a#secret",
    "https:shop.example/a?email=secret&utm_source=a#secret",
    "\\\\shop.example\\a?email=secret&utm_source=a#secret",
  ]) {
    p.host.dataLayer.push({
      event: "search",
      page_location: value,
      page_referrer: value,
      link_url: value,
      checkout_url: value,
      search_term: "red shoes?size=42#XL",
      items: [{ item_name: "Boots / XL" }],
    });
    await settle();
    const params = JSON.parse(String(p.fetcher.mock.calls.at(-1)![1]!.body)).params;
    for (const key of ["page_location", "page_referrer", "link_url", "checkout_url"]) {
      expect(params[key]).not.toMatch(/email|secret|#/);
      expect(params[key]).toContain("utm_source=a");
    }
    expect(params.search_term).toBe("red shoes?size=42#XL");
    expect(params.items[0].item_name).toBe("Boots / XL");
  }
});

it("automatic URL fields never contain credentials, private query values or fragments", async () => {
  const p = page([["consent", "update", grant]]);
  p.host.location.href =
    "https://user:pass@shop.example/reset?token=abc&utm_source=test#access_token=xyz";
  p.host.history.pushState({}, "", p.host.location.href);
  p.host.dispatchEvent(new Event("popstate"));
  await settle();
  const event = JSON.parse(String(p.fetcher.mock.calls.at(-1)![1]!.body));
  expect(event.params.page_location).toBe("https://shop.example/reset?utm_source=test");
});

it("slash-prefixed search and product names stay unchanged on client and server", async () => {
  const params = {
    search_term: "/red shoes?size=42#XL",
    items: [{ item_name: "/ AC/DC #1" }],
  };
  const p = page([["consent", "update", grant]]);
  await settle();
  p.host.dataLayer.push({ event: "search", ...params });
  await settle();
  const event = JSON.parse(String(p.fetcher.mock.calls.at(-1)![1]!.body));
  expect(event.params.search_term).toBe(params.search_term);
  expect(event.params.items[0].item_name).toBe(params.items[0]!.item_name);
  const google = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const app = createApp(dest, google);
  try {
    const result = await app.inject({
      method: "POST",
      url: "/e",
      headers: { origin: dest.siteOrigin },
      payload: { ...event, params },
    });
    expect(result.statusCode).toBe(204);
    const sent = JSON.parse(String(google.mock.calls[0]![1]!.body)).events.at(-1).params;
    expect(sent.search_term).toBe(params.search_term);
    expect(sent.items[0].item_name).toBe(params.items[0]!.item_name);
  } finally {
    await app.close();
  }
});

it("independent: regrant, external page views and changed SPA location emits a second page view", async () => {
  const p = page([["consent", "update", grant]]);
  await settle();
  p.command("consent", "update", { analytics_storage: "denied" });
  p.command("consent", "update", grant);
  p.host.location.href = "https://shop.example/new-route";
  p.host.dispatchEvent(new Event("popstate"));
  p.host.dataLayer.push({ event: "page_view" });
  p.command("event", "page_view");
  (p.host.setInterval.mock.calls[0]![0] as () => void)();
  await settle();
  expect(p.fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
    "/e",
    "/p",
    "/e",
    "/e",
  ]);
});

it("independent: cookie collector rejects missing, unknown and denied analytics even with granted ads", async () => {
  const now = Date.now();
  const google = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const app = createApp(dest, google);
  try {
    for (const value of [undefined, "unknown", "denied"]) {
      const p = page([
        ["consent", "update", { ...grant, analytics_storage: value }],
        { event: "purchase", transaction_id: "blocked" },
      ]);
      await settle();
      expect(p.fetcher.mock.calls.every(([url]) => String(url).endsWith("/p"))).toBe(true);
      const result = await app.inject({
        method: "POST",
        url: "/e",
        headers: { origin: dest.siteOrigin },
        payload: {
          event_id: crypto.randomUUID(),
          name: "purchase",
          client_id: "123.456",
          session_id: 123,
          session_started_ms: now - 1000,
          session_expires_ms: now + 1800000,
          timestamp_ms: now,
          consent: { ...grant, analytics_storage: value },
          params: {},
        },
      });
      expect(result.statusCode).toBe(403);
    }
    expect(google).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it("relative forms are sanitized only in URL fields while ordinary text is preserved exactly", () => {
  const relativeForms = [
    "/red shoes?size=42#XL",
    "/ AC/DC #1",
    "checkout?email=secret&utm_source=test#secret",
    "//shop.example/checkout?email=secret&utm_source=test#secret",
    "https:shop.example/checkout?email=secret&utm_source=test#secret",
    "\\\\shop.example\\checkout?email=secret&utm_source=test#secret",
  ];
  for (const text of relativeForms) {
    const original = { search_term: text, items: [{ item_name: text }] };
    expect(cleanUrls(original)).toEqual(original);
  }
  const urlForms = [
    "/checkout?email=secret&utm_source=test#secret",
    "checkout?email=secret&utm_source=test#secret",
    "//shop.example/checkout?email=secret&utm_source=test#secret",
    " https://shop.example/checkout?email=secret&utm_source=test#secret ",
    "https:shop.example/checkout?email=secret&utm_source=test#secret",
    "\\\\shop.example\\checkout?email=secret&utm_source=test#secret",
    "http://shop.example/checkout?email=secret&utm_source=test#secret",
  ];
  const fields = [
    "page_location",
    "page_referrer",
    "link_url",
    "checkout_url",
    "first_location",
    "previous_referrer",
  ];
  for (const value of urlForms) {
    const clean = cleanUrls(Object.fromEntries(fields.map((key) => [key, value]))) as Record<
      string,
      string
    >;
    for (const key of fields) {
      expect(clean[key]).not.toMatch(/email|secret|#/);
      expect(clean[key]).toContain("utm_source=test");
    }
    const array = cleanUrls({ link_url: [value] }) as {
      link_url: string[];
    };
    expect(array.link_url[0]).toBe(clean.link_url);
  }
  // Clearly absolute URLs are sanitized even in parameters without URL names.
  for (const protocol of ["http", "https"]) {
    const value = `  ${protocol}://shop.example/checkout?email=secret&utm_source=test#secret  `;
    expect(cleanUrls({ search_term: value, items: [{ item_name: value }] })).toEqual({
      search_term: `${protocol}://shop.example/checkout?utm_source=test`,
      items: [{ item_name: `${protocol}://shop.example/checkout?utm_source=test` }],
    });
  }
});

it("URLs set by the site are cleaned like automatic ones", async () => {
  const p = page([["consent", "update", { analytics_storage: "granted" }]]);
  p.host.dataLayer.push({
    event: "generate_lead",
    page_location: "https://shop.example/thanks?email=a@b.cz&utm_source=x#frag",
    page_referrer: "https://x.example/?token=secret",
    link_url: "/next?email=a@b.cz",
    store_location: "Prague",
  });
  for (let i = 0; i < 30; i++) await Promise.resolve();
  const lead = p.fetcher.mock.calls
    .map(([, options]) => JSON.parse(String(options?.body)))
    .find((body) => body.name === "generate_lead");
  expect(lead.params).toMatchObject({
    page_location: "https://shop.example/thanks?utm_source=x",
    page_referrer: "https://x.example/",
    link_url: "/next",
    store_location: "Prague",
  });
});

it("an empty referrer stays empty instead of becoming a root path", () => {
  expect(sanitizeUrl("")).toBe("");
  expect(sanitizeUrl("   ")).toBe("");
});
