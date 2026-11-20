import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { collectRequest } from "../src/server/google.js";
import { withLabels } from "../src/server/labels.js";
import { validateParams } from "../src/server/mp-validation.js";
import { readTraffic } from "../src/client/traffic.js";
import { page } from "./browser-fixture.js";

const classes = ["human", "suspicious", "automated", "declared_agent"] as const;
const snapshot = (value: string, phase = "final") =>
  Object.freeze({ class: value, score: 0, phase, version: "1.0.0" });
const flushAsync = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** A page with the detector's global, defined like the detector: read-only and non-configurable. */
function detected(read?: () => unknown) {
  const p = page();
  if (read) Object.defineProperty(p.host, "__visitorVerdict", { get: read });
  const sent = (path: string) =>
    p.fetcher.mock.calls
      .filter(([url]) => new URL(String(url)).pathname === path)
      .map(([, init]) => JSON.parse(String(init?.body)) as { name: string; params: object });
  return { ...p, sent };
}

for (const value of classes)
  it(`forwards the ${value} browser class on full events and denied pings`, async () => {
    const p = detected(() => snapshot(value));
    p.command("consent", "update", { analytics_storage: "denied" });
    p.host.dataLayer.push({ event: "generate_lead", value: 1 });
    p.command("consent", "update", { analytics_storage: "granted" });
    p.command("event", "generate_lead", { value: 1 });
    await flushAsync();
    const pings = p.sent("/d");
    const events = p.sent("/e");
    expect(pings.map((ping) => ping.name)).toEqual(["page_view", "generate_lead"]);
    expect(events.map((event) => event.name)).toEqual(["page_view", "generate_lead"]);
    for (const hit of [...pings, ...events])
      expect(hit.params).toMatchObject({ traffic_class: value, traffic_phase: "final" });
  });

it("ignores fields a later detector version may add", async () => {
  const p = detected(() => Object.freeze({ ...snapshot("automated"), extra: 1 }));
  p.command("consent", "update", { analytics_storage: "granted" });
  p.command("event", "generate_lead", { value: 1 });
  await flushAsync();
  const events = p.sent("/e");
  expect(events.map((event) => event.name)).toEqual(["page_view", "generate_lead"]);
  for (const hit of events) {
    expect(hit.params).toMatchObject({ traffic_class: "automated", traffic_phase: "final" });
    expect(hit.params).not.toHaveProperty("extra");
  }
});

it("reads the latest phase for every request and sends nothing extra", async () => {
  let phase = "initial";
  const p = detected(() => snapshot("suspicious", phase));
  p.command("consent", "update", { analytics_storage: "granted" });
  await flushAsync();
  phase = "final";
  p.command("event", "generate_lead", { value: 1 });
  await flushAsync();
  expect(p.sent("/e").map((event) => event.params)).toMatchObject([
    { traffic_class: "suspicious", traffic_phase: "initial" },
    { traffic_class: "suspicious", traffic_phase: "final" },
  ]);
  // No storage, cookie or extra request: the fixture throws on storage and counts cookie reads.
  expect(p.cookieReads()).toBe(0);
  expect(p.fetcher).toHaveBeenCalledTimes(2);
});

const invalid: [string, (() => unknown) | undefined][] = [
  ["no detector", undefined],
  ["an unknown class", () => snapshot("robot")],
  ["a class that is not a string", () => Object.freeze({ ...snapshot("human"), class: ["human"] })],
  [
    "a getter that throws",
    () => {
      throw new Error("hostile");
    },
  ],
  [
    "an object that is not frozen",
    () => ({ class: "human", score: 0, phase: "final", version: "1" }),
  ],
  [
    "a proxy whose traps throw",
    () =>
      new Proxy(snapshot("human"), {
        ownKeys() {
          throw new Error("hostile");
        },
      }),
  ],
  ["a primitive", () => "human"],
  ["null", () => null],
];
for (const [label, read] of invalid)
  it(`adds no browser class for ${label} and still sends the events`, async () => {
    const p = detected(read);
    p.command("consent", "update", { analytics_storage: "denied" });
    p.command("consent", "update", { analytics_storage: "granted" });
    p.command("event", "generate_lead", { value: 1 });
    await flushAsync();
    const hits = [...p.sent("/d"), ...p.sent("/e")];
    expect(hits.map((hit) => hit.name)).toEqual(["page_view", "page_view", "generate_lead"]);
    for (const hit of hits) {
      expect(hit.params).not.toHaveProperty("traffic_class");
      expect(hit.params).not.toHaveProperty("traffic_phase");
    }
    expect(p.warnings).not.toHaveBeenCalledWith(expect.stringContaining("Invalid event"));
  });

it("keeps the class but drops an unknown phase in the browser", () => {
  expect(readTraffic({ __visitorVerdict: snapshot("automated", "later") })).toEqual({
    traffic_class: "automated",
  });
});

const config = {
  cookieSecret: "s".repeat(64),
  measurementId: "G-TEST",
  siteOrigin: "https://shop.example",
  trackerHost: "kx7qpa.example.com",
};
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function server(agentVerification: boolean) {
  const google = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  // Key directories are unreachable: unsigned visitors are still labelled without network.
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
  const app = createApp({ ...config, agentVerification }, google, { fetcher });
  apps.push(app);
  const post = (path: "/e" | "/d", params: object) => {
    const now = Date.now();
    const common = {
      name: "page_view",
      client_id: "123.456",
      session_id: 123,
      page_id: "123",
      hit_index: 1,
      params: { page_location: config.siteOrigin, ...params },
    };
    return app.inject({
      method: "POST",
      url: path,
      headers: {
        origin: config.siteOrigin,
        "content-type": "application/json",
        "user-agent": "Mozilla/5.0 Chrome/140.0",
      },
      payload:
        path === "/d"
          ? { ...common, consent: { analytics_storage: "denied" } }
          : {
              ...common,
              event_id: crypto.randomUUID(),
              session_started_ms: now,
              session_expires_ms: now + 1800000,
              timestamp_ms: now,
              consent: { analytics_storage: "granted" },
            },
    });
  };
  const hit = () => {
    const [url, init] = google.mock.calls.at(-1)!;
    return new URLSearchParams(new URL(String(url)).search + "&" + (init?.body ?? ""));
  };
  return { post, hit, google };
}

for (const verification of [false, true])
  it(`accepts only known browser classes and phases with verification ${verification ? "on" : "off"}`, async () => {
    const { post, hit, google } = server(verification);
    for (const path of ["/e", "/d"] as const) {
      for (const value of classes) {
        expect(
          (await post(path, { traffic_class: value, traffic_phase: "initial" })).statusCode,
        ).toBe(204);
        expect(hit().get("ep.traffic_class")).toBe(value);
        expect(hit().get("ep.traffic_phase")).toBe("initial");
      }
      const dropped: object[] = [
        { traffic_class: "robot", traffic_phase: "final" },
        { traffic_class: "Human" },
        { traffic_class: 1 },
        { traffic_class: ["human"] },
        { traffic_phase: "final" },
      ];
      for (const params of dropped) {
        expect((await post(path, params)).statusCode).toBe(204);
        expect(hit().has("ep.traffic_class")).toBe(false);
        expect(hit().has("ep.traffic_phase")).toBe(false);
      }
      expect(
        (await post(path, { traffic_class: "human", traffic_phase: "later" })).statusCode,
      ).toBe(204);
      expect(hit().get("ep.traffic_class")).toBe("human");
      expect(hit().has("ep.traffic_phase")).toBe(false);
      expect(hit().get("ep.agent_verification") ?? undefined).toBe(
        verification ? "no_signature" : undefined,
      );
    }
    expect(google).toHaveBeenCalledTimes(2 * (classes.length + 6));
  });

it("keeps server labels, then the browser class, ahead of site parameters under the limit", async () => {
  const custom = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`custom_${i}`, i]));
  const params = {
    page_location: "https://shop.example/",
    ...custom,
    traffic_phase: "final",
    agent_claim: "spoofed",
    traffic_class: "declared_agent",
    session_id: 1,
  };
  const fields = {
    agent_claim: "none",
    agent_verification: "ip_match",
    agent_operator: "google",
    agent_purpose: "crawler",
  };
  const labelled = withLabels(params, fields);
  expect(Object.keys(labelled).slice(0, 6)).toEqual([
    "agent_verification",
    "agent_operator",
    "agent_purpose",
    "agent_claim",
    "traffic_class",
    "traffic_phase",
  ]);
  const kept = validateParams(labelled, () => {});
  expect(Object.keys(kept)).toHaveLength(25);
  expect(kept).toMatchObject({
    ...fields,
    traffic_class: "declared_agent",
    traffic_phase: "final",
  });
  // Automatic fields count first, then the six labels, then site parameters in their order.
  expect(Object.keys(kept)).toEqual([
    "session_id",
    "page_location",
    "agent_verification",
    "agent_operator",
    "agent_purpose",
    "agent_claim",
    "traffic_class",
    "traffic_phase",
    ...Object.keys(custom).slice(0, 17),
  ]);

  // Over HTTP too, with verification on and 30 site parameters.
  const { post, hit } = server(true);
  for (const path of ["/e", "/d"] as const) {
    expect((await post(path, { ...custom, traffic_class: "automated" })).statusCode).toBe(204);
    expect(hit().get("ep.agent_verification")).toBe("no_signature");
    expect(hit().get("ep.traffic_class")).toBe("automated");
    expect([...hit().keys()].filter((key) => /^epn?\./.test(key)).length).toBeLessThanOrEqual(25);
  }
});

it("agent names are reserved even without verification or returned server labels", () => {
  const params = {
    agent_verification: "signature_valid",
    agent_operator: "spoofed",
    agent_purpose: "crawler",
    agent_claim: "site",
    traffic_class: "x",
    ordinary: 1,
  };
  expect(withLabels(params)).toEqual({ ordinary: 1 });
  expect(withLabels(params, {})).toEqual({ ordinary: 1 });
});

it("omits the browser class when it would push a deliverable body over 16 KiB", () => {
  const url = new URL("https://www.google-analytics.com/g/collect?v=2&en=page_view");
  url.searchParams.set("ep.payload", "x".repeat(16350));
  url.searchParams.set("ep.traffic_class", "declared_agent");
  url.searchParams.set("ep.traffic_phase", "initial");
  const request = collectRequest(url, false);
  expect(request).toBeDefined();
  const body = new URLSearchParams(request!.body);
  expect(body.get("ep.payload")).toHaveLength(16350);
  expect(body.has("ep.traffic_class")).toBe(false);
  expect(body.has("ep.traffic_phase")).toBe(false);
});
