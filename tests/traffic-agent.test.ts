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
  // The detector reports an operator only with declared_agent; any other class drops it.
  for (const value of ["human", "suspicious", "automated"])
    expect(
      readTraffic({
        __visitorVerdict: snapshot({ class: value, phase: "final", agent: "openai" }),
      }),
    ).toEqual({ traffic_class: value, traffic_phase: "final" });
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
    vv_type: "unclassified",
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
  // The later unverified marker cannot replace the stronger verified identity, and the claim
  // no longer says dom_marker once the operator comes from memory.
  expect(withLabels({ ...marker, traffic_agent: "anthropic" }, undefined, sticky)).toEqual({
    vv_type: "agent_verified",
    vv_detail: "openai|-|user_directed|-|declared_agent|agent",
  });
  time += 1000;
  // With a server verdict the claim reverts to the hit's own server claim.
  expect(withLabels({ ...marker, traffic_agent: "openai" }, uaClaim, sticky).vv_detail).toBe(
    "openai|no_signature|user_directed|ua_token|declared_agent|agent",
  );
});

const uaClaim = {
  verification: "no_signature" as const,
  agent_purpose: "unknown" as const,
  claimed: { uaTokens: ["Claude-User"], signatureAgents: [] },
  signatures: [],
  reason: "signature_headers_absent",
};
const spoofed = {
  verification: "signature_invalid" as const,
  agent_purpose: "unknown" as const,
  claimed: { uaTokens: [], signatureAgents: ["https://chatgpt.com"] },
  signatures: [],
  reason: "crypto_mismatch",
};
const human = { traffic_class: "human", traffic_phase: "final" };
const transitions: [string, Record<string, unknown>, object | undefined, object][] = [
  // Weaker later hit: sticky type and operator stay, the hit's claim is its own.
  [
    "human",
    human,
    undefined,
    { vv_type: "agent_unverified", vv_detail: "anthropic|-|-|-|human|final" },
  ],
  // Equal rank 3: fresh evidence replaces type and operator.
  [
    "ua_token",
    human,
    uaClaim,
    { vv_type: "crawler_unverified", vv_detail: "none|no_signature|unknown|ua_token|human|final" },
  ],
  [
    "another marker",
    { ...marker, traffic_agent: "openai" },
    undefined,
    { vv_type: "agent_unverified", vv_detail: "openai|-|-|dom_marker|declared_agent|agent" },
  ],
  // Stronger later evidence replaces the marker entirely.
  [
    "bot_spoofed",
    { ...marker, traffic_agent: "openai" },
    spoofed,
    {
      vv_type: "bot_spoofed",
      vv_detail: "none|signature_invalid|unknown|signature_agent|declared_agent|agent",
    },
  ],
  [
    "agent_verified",
    human,
    verified,
    {
      vv_type: "agent_verified",
      vv_detail: "openai|signature_valid|user_directed|signature_agent|human|final",
    },
  ],
];
for (const [label, params, verdict, expected] of transitions)
  it(`moves from an anthropic marker to ${label} in session memory`, () => {
    let time = 1_000_000;
    const memory = createLabelMemory(10, 60_000, () => time);
    const sticky = { memory, key: "session" };
    expect(withLabels({ ...marker, traffic_agent: "anthropic" }, undefined, sticky)).toEqual({
      vv_type: "agent_unverified",
      vv_detail: "anthropic|-|-|dom_marker|declared_agent|agent",
    });
    time += 1000;
    const result = withLabels(params, verdict as never, sticky);
    expect(result).toEqual(expected);
    // dom_marker only ever appears with the operator of the hit's own marker.
    const detail = String(result.vv_detail).split("|");
    if (detail[3] === "dom_marker") expect(detail[0]).toBe(params.traffic_agent);
  });

it("never attributes a marker claim to an inherited operator after spoofed or automated evidence", () => {
  for (const [first, verdict] of [
    [{ traffic_class: "automated", traffic_phase: "final" }, undefined],
    [human, spoofed],
  ] as const) {
    let time = 1_000_000;
    const memory = createLabelMemory(10, 60_000, () => time);
    const sticky = { memory, key: "session" };
    withLabels(first, verdict as never, sticky);
    time += 1000;
    const result = withLabels({ ...marker, traffic_agent: "openai" }, undefined, sticky);
    expect(String(result.vv_detail).split("|")[3]).toBe("-");
    expect(String(result.vv_detail).split("|")[0]).toBe("none");
  }
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
