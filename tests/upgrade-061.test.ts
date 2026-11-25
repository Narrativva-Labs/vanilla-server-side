import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { visitorLabels, type AgentVerdict } from "visitor-verdict-server";
import { createLabelMemory, verdictEcho, withLabels } from "../src/server/labels.js";
import { serverVerdict } from "../src/shared/verdict.js";
import { createVerdictEcho } from "../src/client/server-verdict.js";
import { readTraffic } from "../src/client/traffic.js";
import { createApp } from "../src/server/app.js";
const platform: AgentVerdict = {
  verification: "signature_valid",
  agent_purpose: "intermediary",
  verified: { operator: "browserbase", method: "signature", expiresAt: 1800000060 },
  claimed: { uaTokens: [], signatureAgents: ["https://www.browserbase.com"] },
  reason: "verified",
  signatures: [],
};
const platformLabels = visitorLabels({ verdict: platform });
for (const legacy of [false, true]) {
  const infra = {
    ...platformLabels,
    vv_type: legacy ? ("agent_verified" as const) : ("automation_verified" as const),
  };
  for (const type of ["agent_verified", "crawler_verified"] as const)
    it(`${legacy ? "legacy" : "new"} infrastructure ranks below ${type} in either order`, () => {
      const direct = {
        vv_type: type,
        vv_detail: `openai|signature_valid|${type === "crawler_verified" ? "crawler" : "user_directed"}|signature_agent|human|final`,
      };
      const m = createLabelMemory(10, 100, () => 0);
      m.apply("a", direct);
      expect(m.apply("a", infra).vv_type).toBe(type);
      expect(m.apply("a", infra).vv_detail.split("|")[0]).toBe("openai");
      m.apply("b", infra);
      expect(m.apply("b", direct).vv_type).toBe(type);
    });
  it(`${legacy ? "legacy" : "new"} infrastructure outranks spoofed and respects proof expiration`, () => {
    let now = 1000;
    const m = createLabelMemory(10, 1000, () => now);
    m.apply("s", infra, true, 1020);
    const spoofed = {
      vv_type: "bot_spoofed" as const,
      vv_detail: "none|signature_invalid|unknown|signature_agent|human|final",
    };
    expect(m.apply("s", spoofed).vv_type).toBe(infra.vv_type);
    now = 1021;
    expect(m.apply("s", visitorLabels({ browserClass: "human" })).vv_type).toBe("human");
    m.apply("x", spoofed);
    expect(m.apply("x", infra).vv_type).toBe(infra.vv_type);
  });
}
it("does not retain automation proof beyond expiry or inherit it on replay", () => {
  const m = createLabelMemory(10, 1000, () => 1000);
  m.apply("s", platformLabels, true, 1100);
  const own = visitorLabels({ browserClass: "declared_agent" });
  expect(m.apply("s", own, true, undefined, true)).toEqual(own);
  const empty = createLabelMemory(10, 1000, () => 1000);
  empty.apply("expired", platformLabels, true, NaN);
  expect(empty.size).toBe(0);
});
it("accepts new and legacy intermediary echoes but rejects inconsistent automation purpose", () => {
  const vv = verdictEcho(platform, 1800000000)!;
  expect(vv).toMatchObject({
    v: 1,
    type: "agent_verified",
    purpose: "intermediary",
    operator: "browserbase",
    ttl: 60,
  });
  expect(serverVerdict(vv)).toEqual(vv);
  expect(serverVerdict({ ...vv, type: "automation_verified" })).toBeDefined();
  for (const purpose of ["user_directed", "unknown", "crawler"])
    expect(serverVerdict({ ...vv, type: "automation_verified", purpose })).toBeUndefined();
});
it("publishes and restores an automation echo as infrastructure and still suppresses crawlers", async () => {
  const vv = verdictEcho(platform, 1800000000)!;
  const saved = new Map<string, string>();
  const host = {
    dataLayer: [] as Record<string, unknown>[],
    sessionStorage: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => {
        saved.set(key, value);
      },
      removeItem: (key: string) => {
        saved.delete(key);
      },
    },
  };
  const receive = createVerdictEcho(host, () => 1000);
  receive.consent(true);
  await receive(Response.json({ vv }), true);
  expect(host.dataLayer).toMatchObject([
    {
      traffic_class: "declared_agent",
      traffic_phase: "agent",
      traffic_agent: "browserbase",
      traffic_agent_claim: "server_intermediary",
      traffic_source: "vanilla",
    },
  ]);
  const restored = { ...host, dataLayer: [] };
  createVerdictEcho(restored, () => 1001);
  expect(restored.dataLayer).toEqual(host.dataLayer);
  await receive(
    Response.json({
      vv: { ...vv, type: "crawler_verified", purpose: "crawler", operator: "openai" },
    }),
  );
  expect(host.dataLayer).toHaveLength(1);
});
for (const claim of [
  undefined,
  "dom_marker",
  "dom_host",
  "server_signature",
  "server_ip",
  "server_intermediary",
  "email@test",
])
  it(`passes only safe browser claim ${String(claim)} into labels`, () => {
    const params = {
      traffic_class: "declared_agent",
      traffic_phase: "agent",
      traffic_agent: "openai",
      traffic_agent_claim: claim,
    };
    const labels = withLabels(params);
    expect(String(labels.vv_detail).split("|")[3]).toBe(
      claim === "dom_host" ? "dom_host" : "dom_marker",
    );
    expect(labels).not.toHaveProperty("traffic_agent_claim");
    const snapshot = readTraffic({
      __visitorVerdict: Object.freeze({
        class: "declared_agent",
        phase: "agent",
        agent: "openai",
        claim,
      }),
    });
    expect(snapshot.traffic_agent_claim).toBe(
      claim === "dom_host" || claim === "dom_marker" ? claim : undefined,
    );
  });
it("a host claim cannot contaminate inherited direct or infrastructure proof", () => {
  const memory = createLabelMemory(10, 1000, () => 1800000000000);
  withLabels({}, platform, { memory, key: "s" });
  const inherited = withLabels(
    {
      traffic_class: "declared_agent",
      traffic_phase: "agent",
      traffic_agent: "openai",
      traffic_agent_claim: "dom_host",
    },
    undefined,
    { memory, key: "s" },
  );
  expect(inherited.vv_type).toBe("automation_verified");
  expect(String(inherited.vv_detail).split("|").slice(0, 4)).toEqual([
    "browserbase",
    "-",
    "intermediary",
    "-",
  ]);
});
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
for (const route of ["/d", "/e"])
  it(`preserves dom_host from browser update to Google on ${route}`, async () => {
    const fields: URLSearchParams[] = [];
    const app = createApp(
      { measurementId: "G-TEST", siteOrigin: "https://shop.example", cookieSecret: "s".repeat(64) },
      async (url, init) => {
        fields.push(new URLSearchParams(new URL(String(url)).search + "&" + (init?.body ?? "")));
        return new Response(null, { status: 204 });
      },
    );
    apps.push(app);
    const now = Date.now();
    const common = {
      name: "traffic_class",
      client_id: "1.2",
      session_id: 1,
      page_id: "1",
      hit_index: 1,
      params: {
        traffic_class: "declared_agent",
        traffic_phase: "agent",
        traffic_agent: "openai",
        traffic_agent_claim: "dom_host",
      },
      consent: { analytics_storage: route === "/d" ? "denied" : "granted" },
    };
    const payload =
      route === "/d"
        ? common
        : {
            ...common,
            event_id: crypto.randomUUID(),
            timestamp_ms: now,
            session_started_ms: now,
            session_expires_ms: now + 1800000,
          };
    expect(
      (
        await app.inject({
          method: "POST",
          url: route,
          headers: { origin: "https://shop.example" },
          payload,
        })
      ).statusCode,
    ).toBe(204);
    expect(fields[0]!.get("ep.vv_detail")?.split("|")[3]).toBe("dom_host");
  });
it("pins vendor bytes, package version and npm integrity", () => {
  const bytes = readFileSync(
    new URL("../vendor/visitor-verdict-server-0.8.0.tgz", import.meta.url),
  );
  const digest = createHash("sha512").update(bytes).digest();
  expect(digest.toString("hex")).toBe(
    "3ff27ac30b463906cdf0e52fe25ccb9311bea89434e1cd81469d22aa431fb9da65fd59021b10a6fdca4ef1595b22c04835e8eb37e1d1e872de9f16adc16e47b3",
  );
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(pkg.version).toBe("0.5.0");
  expect(lock.packages["node_modules/visitor-verdict-server"].version).toBe("0.8.0");
  expect(lock.version).toBe(pkg.version);
  expect(lock.packages[""].version).toBe(pkg.version);
  expect(lock.packages["node_modules/visitor-verdict-server"].integrity).toBe(
    "sha512-" + digest.toString("base64"),
  );
});
