import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { createLabelMemory, withLabels } from "../src/server/labels.js";
import { readTraffic } from "../src/client/traffic.js";
import { trafficFields } from "../src/shared/traffic.js";
import { page } from "./browser-fixture.js";

const snapshot = (fields: Record<string, unknown>) =>
  Object.freeze({
    class: "declared_agent",
    score: 100,
    phase: "agent",
    version: "1.1.0",
    ...fields,
  });
const flushAsync = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const unknownAgents: unknown[] = [
  "google",
  "OpenAI",
  "Anthropic",
  " anthropic",
  "openai|x",
  "",
  1,
  ["openai"],
  { toString: () => "openai" },
  null,
];

it("reads the page-marker operator and the agent phase in the browser", () => {
  for (const agent of ["openai", "anthropic"])
    expect(readTraffic({ __visitorVerdict: snapshot({ agent }) })).toEqual({
      traffic_class: "declared_agent",
      traffic_phase: "agent",
      traffic_agent: agent,
    });
});

it("gives an older detector without agent exactly the class and phase", () => {
  const old = Object.freeze({ class: "human", score: 0, phase: "final", version: "1.0.1" });
  expect(readTraffic({ __visitorVerdict: old })).toEqual({
    traffic_class: "human",
    traffic_phase: "final",
  });
});

it("drops an unknown operator on its own and sends nothing without a valid class", () => {
  for (const agent of unknownAgents)
    expect(readTraffic({ __visitorVerdict: snapshot({ agent }) })).toEqual({
      traffic_class: "declared_agent",
      traffic_phase: "agent",
    });
  expect(readTraffic({ __visitorVerdict: snapshot({ class: "robot", agent: "openai" }) })).toEqual(
    {},
  );
  expect(readTraffic({ __visitorVerdict: { class: "declared_agent", agent: "openai" } })).toEqual(
    {},
  );
  expect(trafficFields("declared_agent", "later", "anthropic")).toEqual({
    traffic_class: "declared_agent",
    traffic_agent: "anthropic",
  });
});

it("sends traffic_agent on full events and denied pings", async () => {
  const p = page();
  Object.defineProperty(p.host, "__visitorVerdict", {
    get: () => snapshot({ agent: "anthropic" }),
  });
  p.command("consent", "update", { analytics_storage: "denied" });
  p.command("consent", "update", { analytics_storage: "granted" });
  p.command("event", "generate_lead", { value: 1 });
  await flushAsync();
  const hits = p.fetcher.mock.calls
    .filter(([url]) => ["/d", "/e"].includes(new URL(String(url)).pathname))
    .map(([url, init]) => ({
      path: new URL(String(url)).pathname,
      ...(JSON.parse(String(init?.body)) as { name: string; params: object }),
    }));
  expect(hits.map((hit) => `${hit.path} ${hit.name}`)).toEqual([
    "/d page_view",
    "/e page_view",
    "/e generate_lead",
  ]);
  for (const hit of hits)
    expect(hit.params).toMatchObject({
      traffic_class: "declared_agent",
      traffic_phase: "agent",
      traffic_agent: "anthropic",
    });
});

const verified = {
  verification: "signature_valid" as const,
  agent_purpose: "user_directed" as const,
  verified: { operator: "openai", method: "signature" as const },
  claimed: { uaTokens: [], signatureAgents: ["https://chatgpt.com"] },
  signatures: [],
  reason: "valid",
};
const marker = { traffic_class: "declared_agent", traffic_phase: "agent" };

it("uses a valid marker as the unverified operator and strips traffic_agent", () => {
  expect(withLabels({ ...marker, traffic_agent: "anthropic", ordinary: 1 })).toEqual({
    vv_type: "agent_unverified",
    vv_detail: "anthropic|-|-|dom_marker|declared_agent|agent",
    ordinary: 1,
  });
  for (const agent of unknownAgents)
    expect(withLabels({ ...marker, traffic_agent: agent })).toEqual({
      vv_type: "agent_unverified",
      vv_detail: "none|-|-|-|declared_agent|agent",
    });
  // Reserved even without a valid class, like the other browser inputs.
  expect(withLabels({ traffic_agent: "openai" })).toEqual({
    vv_type: "pending",
    vv_detail: "none|-|-|-|-|-",
  });
  // A marker on any other class names no operator.
  expect(
    withLabels({ traffic_class: "human", traffic_phase: "final", traffic_agent: "openai" }),
  ).toEqual({ vv_type: "human", vv_detail: "none|-|-|-|human|final" });
});

it("keeps a verified operator over a conflicting marker, also in session memory", () => {
  expect(withLabels({ ...marker, traffic_agent: "anthropic" }, verified)).toEqual({
    vv_type: "agent_verified",
    vv_detail: "openai|signature_valid|user_directed|signature_agent|declared_agent|agent",
  });
  let time = 1_000_000;
  const memory = createLabelMemory(10, 60_000, () => time);
  const sticky = { memory, key: "session" };
  withLabels({ traffic_class: "human", traffic_phase: "final" }, verified, sticky);
  time += 1000;
  // The later unverified marker cannot replace the stronger verified identity.
  expect(withLabels({ ...marker, traffic_agent: "anthropic" }, undefined, sticky)).toEqual({
    vv_type: "agent_verified",
    vv_detail: "openai|-|-|dom_marker|declared_agent|agent",
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

for (const agentVerification of [false, true])
  it(`labels the marker operator on /e and /d with verification ${agentVerification}`, async () => {
    const google = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
    const app = createApp({ ...config, agentVerification }, google, { fetcher });
    apps.push(app);
    let n = 0;
    for (const path of ["/e", "/d"] as const)
      for (const [agent, operator, claim] of [
        ["openai", "openai", "dom_marker"],
        ["google", "none", agentVerification ? "none" : "-"],
      ] as const) {
        const now = Date.now();
        // A fresh session for each hit, so no sticky operator carries over.
        const common = {
          name: "page_view",
          client_id: `${++n}.456`,
          session_id: n,
          page_id: String(n),
          hit_index: 1,
          params: { page_location: config.siteOrigin, ...marker, traffic_agent: agent },
        };
        const response = await app.inject({
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
        expect(response.statusCode).toBe(204);
        const [url, init] = google.mock.calls.at(-1)!;
        const hit = new URLSearchParams(new URL(String(url)).search + "&" + (init?.body ?? ""));
        expect(hit.get("ep.vv_type")).toBe("agent_unverified");
        const detail = hit.get("ep.vv_detail")!.split("|");
        expect([detail[0], detail[3], detail[4], detail[5]]).toEqual([
          operator,
          claim,
          "declared_agent",
          "agent",
        ]);
        for (const name of ["traffic_agent", "traffic_class", "traffic_phase"])
          expect(hit.has(`ep.${name}`)).toBe(false);
      }
  });
