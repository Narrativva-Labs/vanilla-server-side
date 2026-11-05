/** Regression coverage for consent races, interrupted navigation and MP validation. */
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { serverIdentity } from "../src/server/identity.js";
import { page } from "./browser-fixture.js";

const config = { siteOrigin: "https://shop.example", cookieDomain: "shop.example",
  cookieSecret: "s".repeat(64), measurementId: "G-TEST", apiSecret: "test" };
const granted = { analytics_storage: "granted" };
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const event = () => ({ event_id: crypto.randomUUID(), name: "page_view", client_id: "123.456",
  session_id: 123, session_started_ms: Date.now(), session_expires_ms: Date.now() + 1800000,
  timestamp_ms: Date.now(), consent: granted, campaign: { source: "newsletter", medium: "email" }, params: {} });
afterEach(() => vi.useRealTimers());

it("an active collect cannot restore a cookie after consent withdrawal", async () => {
  let finish!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const google = vi.fn<typeof fetch>(async () => {
    started();
    await blocked;
    return new Response(null, { status: 204 });
  });
  const app = createApp(config, google);
  const cookie = serverIdentity(config).cookie.split(";")[0]!;
  let pending: Promise<unknown> | undefined;
  try {
    pending = app.inject({ method: "POST", url: "/e", headers: { origin: config.siteOrigin, cookie }, payload: event() })
      .then(reply => {
        expect(reply.headers["set-cookie"]).toBeUndefined();
        expect(reply.statusCode).toBe(204);
      });
    await entered;
    const deletion = await app.inject({ method: "POST", url: "/p", headers: { origin: config.siteOrigin, cookie }, payload: {} });
    expect(deletion.statusCode).toBe(204);
    expect(String(deletion.headers["set-cookie"])).toContain("Max-Age=0");
    finish();
    await pending;
  } finally { finish(); await pending; await app.close(); }
});

it("first Google 503 does not confirm a session; retry preserves campaign_details", async () => {
  const google = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValue(new Response(null, { status: 204 }));
  const app = createApp(config, google);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const payload = event();
    const first = await app.inject({ method: "POST", url: "/e", headers: { origin: config.siteOrigin }, payload });
    expect(first.statusCode).toBe(503);
    expect(first.headers["set-cookie"]).toBeUndefined();
    const cookie = "";
    const retry = await app.inject({ method: "POST", url: "/e", headers: { origin: config.siteOrigin, cookie }, payload });
    expect(retry.statusCode).toBe(204);
    expect(JSON.parse(String(google.mock.calls[0]![1]!.body)).events.map((e: { name: string }) => e.name))
      .toEqual(["campaign_details", "page_view"]);
    expect(JSON.parse(String(google.mock.calls[1]![1]!.body)).events.map((e: { name: string }) => e.name))
      .toEqual(["campaign_details", "page_view"]);
  } finally { log.mockRestore(); await app.close(); }
});

for (const mode of ["cookie", "cookieless"] as const) {
  it(`${mode} pagehide dispatches engagement immediately while another fetch is pending`, async () => {
    vi.useFakeTimers();
    const p = page(mode, [["consent", "update", granted]]);
    await settle();
    let finish!: (value: Response) => void;
    p.fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    p.command("event", "generate_lead");
    vi.advanceTimersByTime(1200);
    p.doc.visibilityState = "hidden";
    p.doc.dispatchEvent(new Event("visibilitychange"));
    p.host.dispatchEvent(new Event("pagehide"));
    await settle();
    expect(p.fetcher).toHaveBeenCalledTimes(3);
    expect(p.fetcher.mock.calls.map(([, options]) => JSON.parse(String(options!.body)).name))
      .toEqual(["page_view", "generate_lead", "page_engagement"]);
    const exit = p.fetcher.mock.calls[2]![1]!;
    expect(exit.keepalive).toBe(true);
    expect(Buffer.byteLength(String(exit.body))).toBeLessThan(2048);
    expect(JSON.parse(String(exit.body)).params.engagement_time_msec).toBe(1200);
    finish(new Response(null, { status: 204 }));
    await settle();
    expect(p.fetcher.mock.calls.some(([, options]) => JSON.parse(String(options!.body)).name === "page_engagement")).toBe(true);
  });
}

it("a waiting SPA page_view retains the old page but keeps the original campaign", async () => {
  vi.useFakeTimers();
  const p = page("cookie", [["consent", "default", { ...granted, wait_for_update: 500 }]]);
  p.host.history.pushState({}, "", "https://shop.example/new?utm_source=wrong");
  vi.advanceTimersByTime(500);
  (p.host.setInterval.mock.calls[0]![0] as () => void)();
  await settle();
  const first = JSON.parse(String(p.fetcher.mock.calls[0]![1]!.body));
  expect(first.params.page_location).toContain("utm_source=test");
  expect(first.campaign.source).toBe("test");
});

it("time spent denied is excluded from engagement after grant", async () => {
  vi.useFakeTimers();
  const p = page("cookie", [["consent", "update", { analytics_storage: "denied" }]]);
  await settle();
  vi.advanceTimersByTime(10000);
  p.command("consent", "update", granted);
  await settle();
  const collect = p.fetcher.mock.calls.find(([url]) => String(url).endsWith("/e"))!;
  expect(JSON.parse(String(collect[1]!.body)).params.engagement_time_msec).toBe(0);
});

it("collector limits final parameters and drops invalid names and long custom values", async () => {
  const google = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const app = createApp(config, google);
  try {
    const params = { ...Object.fromEntries(Array.from({ length: 26 }, (_, i) => [`field_${i}`, i])),
      "bad-name": "x", custom: "x".repeat(101) };
    const response = await app.inject({ method: "POST", url: "/e", headers: { origin: config.siteOrigin }, payload: { ...event(), params } });
    expect(response.statusCode).toBe(204);
    const sent = JSON.parse(String(google.mock.calls[0]![1]!.body)).events.at(-1).params;
    expect(Object.keys(sent)).toHaveLength(25);
    expect(sent.session_id).toEqual(expect.any(Number));
    expect(sent["bad-name"]).toBeUndefined();
    expect(sent.custom).toBeUndefined();
  } finally { await app.close(); }
});

it("malformed non-ASCII cookie signature starts a fresh identity", async () => {
  expect(() => serverIdentity(config, `vanilla_session=e30.${"é".repeat(43)}`)).not.toThrow();
  const google = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const app = createApp(config, google);
  try {
    const response = await app.inject({ method: "POST", url: "/e", headers: {
      origin: config.siteOrigin, cookie: `vanilla_session=e30.${"é".repeat(43)}` }, payload: event() });
    expect(response.statusCode).toBe(204);
    expect(google).toHaveBeenCalledTimes(1);
    expect((await app.inject("/health")).json().ok).toBe(true);
  } finally { await app.close(); }
});

it("tracker rejects an oversized keepalive body before fetch with a diagnostic", async () => {
  const p = page("cookie", [["consent", "update", granted]]);
  await settle();
  p.command("event", "generate_lead", { note: "x".repeat(70 * 1024) });
  await settle();
  expect(p.fetcher).toHaveBeenCalledTimes(1); // Initial page only.
  expect(p.warnings).toHaveBeenCalledWith(expect.stringContaining("32 KiB"));

});

it("concurrent first requests reuse the transient browser identity", async () => {
  const google = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const app = createApp(config, google);
  try {
    const replies = await Promise.all(Array.from({ length: 2 }, () => app.inject({ method: "POST", url: "/e",
      headers: { origin: config.siteOrigin }, payload: event() })));
    expect(replies.every(r => r.statusCode === 204)).toBe(true);
    const ids = google.mock.calls.map(([, options]) => JSON.parse(String(options!.body)).client_id);
    expect(new Set(ids).size).toBe(1);
  } finally { await app.close(); }
});

it("withdrawal also blocks an initial collect response before any server cookie exists", async () => {
  let finish!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const app = createApp(config, vi.fn<typeof fetch>(async () => {
    started(); await blocked; return new Response(null, { status: 204 });
  }));
  const payload = event();
  const pending = app.inject({ method: "POST", url: "/e", headers: { origin: config.siteOrigin }, payload }).then(reply => {
    expect(reply.statusCode).toBe(204);
    expect(reply.headers["set-cookie"]).toBeUndefined();
  });
  try {
    await entered;
    await app.inject({ method: "POST", url: "/p", headers: { origin: config.siteOrigin },
      payload: { client_id: payload.client_id } });
    finish(); await pending;
  } finally { finish(); await pending; await app.close(); }
});
