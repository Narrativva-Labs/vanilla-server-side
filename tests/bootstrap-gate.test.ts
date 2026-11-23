import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { page } from "./browser-fixture.js";

// The bootstrap secret and the data-vv-wait-ms readiness gate together: hits held by the gate are
// built with the consented identity and its secret, and the hits the gate releases at once still
// join one client and one session on the collector before the signed cookie arrives.
afterEach(() => vi.useRealTimers());

const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const tokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const denied = { analytics_storage: "denied", ad_storage: "denied" };
const granted = {
  analytics_storage: "granted",
  ad_storage: "granted",
  ad_user_data: "granted",
  ad_personalization: "granted",
};
const snapshot = (value: string) =>
  Object.freeze({ class: value, score: 100, phase: "initial", version: "1.0.0" });
type Body = { name?: string; bootstrap_token?: string; client_id?: string };

function gated(history: unknown[]) {
  const p = page(history, { dataset: { vvWaitMs: "1000" } });
  const host = p.host as unknown as Record<string, unknown> & { dataLayer: unknown[] };
  const sent = () =>
    p.fetcher.mock.calls.map(([url, init]) => ({
      path: new URL(String(url)).pathname,
      ...(JSON.parse(String(init?.body ?? "{}")) as Body),
    }));
  const publish = () => {
    host.__visitorVerdict = snapshot("automated");
    host.dataLayer.push({ event: "traffic_class", traffic_class: "automated" });
  };
  const fire = (delay: number) =>
    p.host.setTimeout.mock.calls
      .filter(([, ms]) => ms === delay)
      .forEach(([task]) => (task as () => void)());
  return { ...p, sent, publish, fire };
}

for (const release of ["publication", "deadline", "pagehide"] as const) {
  it(`a hit held through a grant carries the bootstrap secret once released by the ${release}`, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const p = gated([["consent", "default", denied]]);
    p.command("event", "generate_lead", { value: 1 });
    await settle();
    expect(p.sent()).toHaveLength(0);
    p.command("consent", "update", granted);
    await settle();
    // Still held: the denied page view is dropped and the full events wait for the gate.
    expect(p.sent()).toHaveLength(0);
    vi.setSystemTime(Date.now() + 400);
    if (release === "publication") p.publish();
    else if (release === "deadline") p.fire(1000);
    else p.host.dispatchEvent(new Event("pagehide"));
    await settle();
    const hits = p.sent();
    // At pagehide the exit hit leaves beside the held page view, without waiting for the queue.
    expect(hits.map((hit) => `${hit.path} ${hit.name}`)).toEqual(
      release === "pagehide"
        ? ["/e page_view", "/e generate_lead", "/e page_engagement"]
        : ["/e page_view", "/e generate_lead"],
    );
    const token = hits[0]!.bootstrap_token;
    expect(token).toMatch(tokenPattern);
    expect(hits.every((hit) => hit.bootstrap_token === token)).toBe(true);
    expect(new Set(hits.map((hit) => hit.client_id)).size).toBe(1);
  });
}

it("held denied pings released by the gate never carry the bootstrap secret", async () => {
  const p = gated([["consent", "default", denied]]);
  p.command("event", "generate_lead", { value: 1 });
  await settle();
  p.publish();
  await settle();
  expect(p.sent().map((hit) => `${hit.path} ${hit.name}`)).toEqual([
    "/d page_view",
    "/d generate_lead",
  ]);
  expect(p.sent().every((hit) => hit.bootstrap_token === undefined)).toBe(true);
});

it("the page view and exit hit released together at pagehide join one client and session", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const config = {
    measurementId: "G-TEST",
    cookieSecret: "s".repeat(64),
    siteOrigin: "https://shop.example",
  };
  // Google answers the first hit only when the test says so, so the opener stays in flight.
  const google: URLSearchParams[] = [];
  let answerGoogle!: () => void;
  const googleGate = new Promise<void>((resolve) => (answerGoogle = resolve));
  let opened!: () => void;
  const openerInFlight = new Promise<void>((resolve) => (opened = resolve));
  const app = createApp(config, async (url) => {
    google.push(new URL(String(url)).searchParams);
    if (google.length === 1) {
      opened();
      await googleGate;
    }
    return new Response(null, { status: 204 });
  });
  // The browser applies Set-Cookie only when a response arrives, like credentials: "include".
  let jar = "";
  const responses: Promise<unknown>[] = [];
  const p = gated([["consent", "default", denied]]);
  p.fetcher.mockImplementation((url, init) => {
    const request = app
      .inject({
        method: "POST",
        url: new URL(String(url)).pathname,
        headers: {
          origin: config.siteOrigin,
          "content-type": "application/json",
          ...(jar ? { cookie: jar } : {}),
        },
        payload: String(init?.body),
      })
      .then((response) => {
        const cookie = response.headers["set-cookie"];
        if (cookie) jar = String(cookie).split(";")[0]!;
        return new Response(null, { status: response.statusCode });
      });
    responses.push(request);
    return request;
  });
  try {
    p.command("event", "generate_lead", { value: 1 });
    await settle();
    p.command("consent", "update", granted);
    await settle();
    expect(p.fetcher).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 400);
    // Leaving releases the held page view and sends the exit hit without waiting for it.
    p.host.dispatchEvent(new Event("pagehide"));
    expect(p.sent().map((hit) => `${hit.path} ${hit.name}`)).toEqual([
      "/e page_view",
      "/e generate_lead",
      "/e page_engagement",
    ]);
    const token = p.sent()[0]!.bootstrap_token;
    expect(token).toMatch(tokenPattern);
    expect(p.sent()[1]!.bootstrap_token).toBe(token);
    await openerInFlight;
    // Both reached the collector before any cookie existed.
    expect(jar).toBe("");
    answerGoogle();
    for (let i = 0; i < 20 && responses.length < 3; i++) {
      await Promise.all(responses);
      await settle();
    }
    await Promise.all(responses);
    expect(p.sent().map((hit) => hit.name)).toEqual([
      "page_view",
      "generate_lead",
      "page_engagement",
    ]);
    expect(google.map((hit) => hit.get("en"))).toEqual(
      expect.arrayContaining(["page_view", "page_engagement", "generate_lead"]),
    );
    expect(google).toHaveLength(3);
    expect(new Set(google.map((hit) => hit.get("cid"))).size).toBe(1);
    expect(new Set(google.map((hit) => hit.get("sid"))).size).toBe(1);
    expect(google.filter((hit) => hit.get("_fv") === "1")).toHaveLength(1);
    expect(google.filter((hit) => hit.get("_ss") === "1")).toHaveLength(1);
    expect(google.every((hit) => !hit.toString().includes(token!))).toBe(true);
  } finally {
    answerGoogle();
    await app.close();
  }
});
