import { expect, it, vi } from "vitest";
import { createTracker } from "../src/client/tracker.js";
import { createApp } from "../src/server/app.js";
import { normalizeConsent } from "../src/shared/consent.js";

const config = {
  siteOrigin: "https://www.example.com",
  cookieDomain: "example.com",
  cookieSecret: "s".repeat(64),
  measurementId: "G-TEST",
  apiSecret: "test",
};
const consent = normalizeConsent({ analytics_storage: "granted" });
const event = (id = crypto.randomUUID()) => {
  const now = Date.now();
  return {
    event_id: id,
    name: "page_view",
    client_id: "123.456",
    session_id: 123,
    session_started_ms: now,
    session_expires_ms: now + 30 * 60 * 1000,
    timestamp_ms: now,
    consent,
    params: {},
  };
};
const post = (app: ReturnType<typeof createApp>, payload: object, cookie = "") =>
  app.inject({
    method: "POST",
    url: "/e",
    headers: { origin: config.siteOrigin, cookie, "content-type": "application/json" },
    payload,
  });

it("collector drops a stale event after consent withdrawal", async () => {
  const google = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const app = createApp(config, google);
  try {
    const firstEvent = event();
    const first = await post(app, firstEvent);
    const cookie = String(first.headers["set-cookie"]);
    const withdrawn = await app.inject({
      method: "POST",
      url: "/p",
      headers: { origin: config.siteOrigin, cookie, "content-type": "application/json" },
      payload: { client_id: firstEvent.client_id },
    });
    expect(withdrawn.statusCode).toBe(204);
    const stale = await post(app, { ...firstEvent, event_id: crypto.randomUUID() }, cookie);
    expect(stale.statusCode).toBe(204);
    expect(stale.headers["set-cookie"]).toBeUndefined();
    expect(google).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});

it("concurrent duplicate requests share the failed delivery result", async () => {
  let finish!: (response: Response) => void;
  const upstream = new Promise<Response>(resolve => { finish = resolve; });
  const google = vi.fn<typeof fetch>(() => upstream);
  const app = createApp(config, google);
  try {
    const payload = event();
    const first = post(app, payload);
    await vi.waitFor(() => expect(google).toHaveBeenCalledTimes(1));
    const duplicate = post(app, payload);
    await new Promise(resolve => setTimeout(resolve, 10));
    finish(new Response(null, { status: 503 }));
    const responses = await Promise.all([first, duplicate]);
    expect(responses.map(response => response.statusCode)).toEqual([503, 503]);
    expect(google).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});

it("cookieless tracker renews an old session instead of stopping after 24 hours", async () => {
  let now = Date.now();
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const tracker = createTracker("https://collector.example/e", {
    href: () => "https://shop.example/",
    referrer: () => "",
    now: () => now,
    uuid: () => crypto.randomUUID(),
    fetch: fetcher,
    warn: vi.fn(),
  }, new Set(["generate_lead"]), "cookieless");
  tracker.update(consent);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  const first = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
  now += 24 * 60 * 60 * 1000 + 1;
  tracker.track("generate_lead");
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  const second = JSON.parse(String(fetcher.mock.calls[1]![1]!.body));
  expect(second.session_id).not.toBe(first.session_id);
});

it("duplicate purchase does not consume measured engagement", async () => {
  const engagement = vi.fn(() => 1000);
  const tracker = createTracker("https://collector.example/e", {
    href: () => "https://shop.example/",
    referrer: () => "",
    now: () => Date.now(),
    uuid: () => crypto.randomUUID(),
    fetch: vi.fn<typeof fetch>(async () => new Response(null, { status: 204 })),
    engagement,
    warn: vi.fn(),
  }, new Set(["purchase"]));
  tracker.update(consent);
  await vi.waitFor(() => expect(engagement).toHaveBeenCalledTimes(1));
  tracker.track("purchase", { transaction_id: "one" });
  await vi.waitFor(() => expect(engagement).toHaveBeenCalledTimes(2));
  tracker.track("purchase", { transaction_id: "one" });
  expect(engagement).toHaveBeenCalledTimes(2);
});
