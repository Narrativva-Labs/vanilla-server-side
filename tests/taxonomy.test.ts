import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as library from "visitor-verdict-server";
import { createVerdictEcho } from "../src/client/server-verdict.js";
import { serverVerdict } from "../src/shared/verdict.js";
import { createLabelMemory, verdictEcho, withLabels } from "../src/server/labels.js";
import { createApp } from "../src/server/app.js";

vi.mock("visitor-verdict-server", async (original) => ({
  ...(await original<typeof library>()),
  createVerifier: vi.fn(),
}));

const ALL_TEN_TYPES = [
  "unclassified",
  "human",
  "bot_suspicious",
  "crawler_unverified",
  "agent_unverified",
  "bot_automation",
  "bot_spoofed",
  "automation_verified",
  "crawler_verified",
  "agent_verified",
] as const;

const ECHO_STORAGE_KEY = "vanilla.verdict.v1";

function loadLegacyEcho020() {
  const source = readFileSync(new URL("./fixtures/echo-020.js", import.meta.url), "utf8");
  return runInNewContext(source + "\nLegacyEcho020;", {
    TextDecoder,
    setTimeout,
    clearTimeout,
  }) as {
    createVerdictEcho: typeof createVerdictEcho;
    serverVerdict: typeof serverVerdict;
  };
}

function makeHost() {
  const values = new Map<string, string>();
  return {
    dataLayer: [] as Record<string, unknown>[],
    values,
    sessionStorage: {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => {
        values.set(k, v);
      },
      removeItem: (k: string) => {
        values.delete(k);
      },
    },
  };
}

function makeVerdict(overrides: Partial<library.AgentVerdict>): library.AgentVerdict {
  return {
    verification: "no_signature",
    agent_purpose: "unknown",
    claimed: { uaTokens: [], signatureAgents: [] },
    signatures: [],
    reason: "no_signature",
    ...overrides,
  };
}

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  vi.restoreAllMocks();
});

describe("0.5.0 vv_type taxonomy in Vanilla", () => {
  it("classifies all 10 vv_type values and preserves user_directed purpose for IP-verified fetchers", () => {
    // 1. unclassified
    expect(withLabels({})).toMatchObject({
      vv_type: "unclassified",
      vv_detail: "none|-|-|-|-|-",
    });

    // 2. human
    expect(withLabels({ traffic_class: "human", traffic_phase: "initial" })).toMatchObject({
      vv_type: "human",
      vv_detail: "none|-|-|-|human|initial",
    });

    // 3. bot_suspicious
    expect(withLabels({ traffic_class: "suspicious", traffic_phase: "final" })).toMatchObject({
      vv_type: "bot_suspicious",
      vv_detail: "none|-|-|-|suspicious|final",
    });

    // 4. crawler_unverified (unverified crawler & fetcher UA claims, including meta-externalagent)
    for (const token of ["GPTBot", "ChatGPT-User", "Claude-User", "meta-externalagent"]) {
      expect(
        withLabels({}, makeVerdict({ claimed: { uaTokens: [token], signatureAgents: [] } })),
      ).toMatchObject({
        vv_type: "crawler_unverified",
        vv_detail: "none|no_signature|unknown|ua_token|-|-",
      });
    }

    // 5. agent_unverified (agent token, unmapped Blueno, unverified WBA signature, browser DOM marker/host)
    for (const token of ["Claude-Agent", "Google-Agent", "Blueno"]) {
      expect(
        withLabels({}, makeVerdict({ claimed: { uaTokens: [token], signatureAgents: [] } })),
      ).toMatchObject({
        vv_type: "agent_unverified",
        vv_detail: "none|no_signature|unknown|ua_token|-|-",
      });
    }
    expect(
      withLabels(
        {},
        makeVerdict({
          verification: "none",
          claimed: { uaTokens: [], signatureAgents: ["https://chatgpt.com"] },
          reason: "directory_unavailable",
        }),
      ),
    ).toMatchObject({
      vv_type: "agent_unverified",
      vv_detail: "none|none|unknown|signature_agent|-|-",
    });
    expect(
      withLabels({
        traffic_class: "declared_agent",
        traffic_phase: "agent",
        traffic_agent: "openai",
        traffic_agent_claim: "dom_marker",
      }),
    ).toMatchObject({
      vv_type: "agent_unverified",
      vv_detail: "openai|-|-|dom_marker|declared_agent|agent",
    });

    // 6. bot_automation
    expect(withLabels({ traffic_class: "automated", traffic_phase: "final" })).toMatchObject({
      vv_type: "bot_automation",
      vv_detail: "none|-|-|-|automated|final",
    });

    // 7. bot_spoofed
    expect(
      withLabels(
        {},
        makeVerdict({
          verification: "signature_invalid",
          claimed: { uaTokens: [], signatureAgents: ["https://chatgpt.com"] },
          reason: "signature_invalid",
        }),
      ),
    ).toMatchObject({
      vv_type: "bot_spoofed",
      vv_detail: "none|signature_invalid|unknown|signature_agent|-|-",
    });

    // 8. automation_verified
    expect(
      withLabels(
        {},
        makeVerdict({
          verification: "signature_valid",
          agent_purpose: "intermediary",
          verified: { operator: "browserbase", method: "signature", expiresAt: 1800000300 },
          claimed: { uaTokens: [], signatureAgents: ["https://www.browserbase.com"] },
          reason: "verified",
        }),
      ),
    ).toMatchObject({
      vv_type: "automation_verified",
      vv_detail: "browserbase|signature_valid|intermediary|signature_agent|-|-",
    });

    // 9. crawler_verified — both crawler IP match AND user-directed fetcher IP match
    expect(
      withLabels(
        {},
        makeVerdict({
          verification: "ip_match",
          agent_purpose: "crawler",
          verified: { operator: "openai", method: "ip", expiresAt: 1800000300 },
          claimed: { uaTokens: ["GPTBot"], signatureAgents: [] },
          reason: "verified",
        }),
      ),
    ).toMatchObject({
      vv_type: "crawler_verified",
      vv_detail: "openai|ip_match|crawler|ua_token|-|-",
    });
    for (const [token, operator] of [
      ["ChatGPT-User", "openai"],
      ["Claude-User", "anthropic"],
      ["Perplexity-User", "perplexity"],
      ["MistralAI-User", "mistral"],
      ["Kimi-User", "kimi"],
    ] as const) {
      expect(
        withLabels(
          {},
          makeVerdict({
            verification: "ip_match",
            agent_purpose: "user_directed",
            verified: { operator, method: "ip", expiresAt: 1800000300 },
            claimed: { uaTokens: [token], signatureAgents: [] },
            reason: "verified",
          }),
        ),
      ).toMatchObject({
        vv_type: "crawler_verified",
        vv_detail: `${operator}|ip_match|user_directed|ua_token|-|-`,
      });
    }

    // 10. agent_verified — WBA signature (even with fetcher UA) AND IP-verified agent tokens
    expect(
      withLabels(
        {},
        makeVerdict({
          verification: "signature_valid",
          agent_purpose: "user_directed",
          verified: { operator: "openai", method: "signature", expiresAt: 1800000300 },
          claimed: { uaTokens: ["ChatGPT-User"], signatureAgents: ["https://chatgpt.com"] },
          reason: "verified",
        }),
      ),
    ).toMatchObject({
      vv_type: "agent_verified",
      vv_detail: "openai|signature_valid|user_directed|signature_agent|-|-",
    });
    for (const [token, operator] of [
      ["Claude-Agent", "anthropic"],
      ["Google-Agent", "google"],
    ] as const) {
      expect(
        withLabels(
          {},
          makeVerdict({
            verification: "ip_match",
            agent_purpose: "user_directed",
            verified: { operator, method: "ip", expiresAt: 1800000300 },
            claimed: { uaTokens: [token], signatureAgents: [] },
            reason: "verified",
          }),
        ),
      ).toMatchObject({
        vv_type: "agent_verified",
        vv_detail: `${operator}|ip_match|user_directed|ua_token|-|-`,
      });
    }
  });

  it("applies sticky session ranks for unclassified (0, unstored) and crawler_unverified (3)", () => {
    let now = 1000;
    const memory = createLabelMemory(10, 60_000, () => now);

    // unclassified never enters sticky memory
    expect(memory.apply("s1", { vv_type: "unclassified", vv_detail: "none|-|-|-|-|-" })).toEqual({
      vv_type: "unclassified",
      vv_detail: "none|-|-|-|-|-",
    });
    expect(memory.size).toBe(0);

    // crawler_unverified (3) beats human (1) and bot_suspicious (2)
    memory.apply("s1", { vv_type: "bot_suspicious", vv_detail: "none|-|-|-|suspicious|final" });
    expect(
      memory.apply("s1", {
        vv_type: "crawler_unverified",
        vv_detail: "none|no_signature|unknown|ua_token|-|-",
      }).vv_type,
    ).toBe("crawler_unverified");

    // human does not downgrade crawler_unverified
    expect(
      memory.apply("s1", { vv_type: "human", vv_detail: "none|-|-|-|human|initial" }).vv_type,
    ).toBe("crawler_unverified");

    // fresh equal-rank agent_unverified (3) replaces crawler_unverified (3)
    expect(
      memory.apply("s1", {
        vv_type: "agent_unverified",
        vv_detail: "openai|-|-|dom_marker|declared_agent|agent",
      }),
    ).toMatchObject({
      vv_type: "agent_unverified",
      vv_detail: "openai|-|-|dom_marker|declared_agent|agent",
    });

    // bot_automation (4) beats crawler_unverified (3)
    expect(
      memory.apply("s2", {
        vv_type: "crawler_unverified",
        vv_detail: "none|no_signature|unknown|ua_token|-|-",
      }).vv_type,
    ).toBe("crawler_unverified");
    expect(
      memory.apply("s2", { vv_type: "bot_automation", vv_detail: "none|-|-|-|automated|final" })
        .vv_type,
    ).toBe("bot_automation");
    now += 100;
    expect(
      memory.apply("s2", {
        vv_type: "crawler_unverified",
        vv_detail: "none|no_signature|unknown|ua_token|-|-",
      }).vv_type,
    ).toBe("bot_automation");
  });

  it("keeps B7 verdict echo backward compatible with frozen 0.2.0 reader for IP-verified fetchers, agents and unverified types", async () => {
    const legacy = loadLegacyEcho020();
    const nowSec = 1800000000;

    // 1. IP-verified fetcher (ChatGPT-User): GA4 keeps crawler_verified + user_directed;
    // B7 echo emits crawler_verified + purpose: "crawler" so cached 0.2.0 clients accept it cleanly and never push to dataLayer.
    const fetcherVerdict = makeVerdict({
      verification: "ip_match",
      agent_purpose: "user_directed",
      verified: { operator: "openai", method: "ip", expiresAt: nowSec + 300 },
      claimed: { uaTokens: ["ChatGPT-User"], signatureAgents: [] },
      reason: "verified",
    });
    expect(withLabels({}, fetcherVerdict)).toMatchObject({
      vv_type: "crawler_verified",
      vv_detail: "openai|ip_match|user_directed|ua_token|-|-",
    });
    const fetcherEcho = verdictEcho(fetcherVerdict, nowSec)!;
    expect(fetcherEcho).toEqual({
      v: 1,
      ttl: 300,
      type: "crawler_verified",
      operator: "openai",
      verification: "ip_match",
      purpose: "crawler",
    });

    // Both frozen 0.2.0 and current 0.5.0 readers accept the wire payload and do not push to dataLayer
    for (const reader of [legacy.createVerdictEcho, createVerdictEcho]) {
      const h = makeHost();
      const receive = reader(h, () => 1000);
      receive.consent(true);
      await receive(Response.json({ vv: fetcherEcho }), true);
      expect(h.dataLayer).toHaveLength(0);
      expect((h as unknown as { __visitorVerdictServer?: unknown }).__visitorVerdictServer).toEqual(
        fetcherEcho,
      );
      expect(JSON.parse(h.values.get(ECHO_STORAGE_KEY)!).vv).toEqual(fetcherEcho);
    }

    // Current serverVerdict also tolerates crawler_verified + user_directed, while frozen 0.2.0 rejects it
    const directFetcherPurpose = { ...fetcherEcho, purpose: "user_directed" as const };
    expect(serverVerdict(directFetcherPurpose)).toEqual(directFetcherPurpose);
    expect(legacy.serverVerdict(directFetcherPurpose)).toBeUndefined();

    // 2. Verified WBA agent & verified IP agent (Claude-Agent): both 0.2.0 and current publish declared_agent
    const wbaAgent = makeVerdict({
      verification: "signature_valid",
      agent_purpose: "user_directed",
      verified: { operator: "openai", method: "signature", expiresAt: nowSec + 300 },
      claimed: { uaTokens: ["ChatGPT-User"], signatureAgents: ["https://chatgpt.com"] },
      reason: "verified",
    });
    const wbaEcho = verdictEcho(wbaAgent, nowSec)!;
    expect(wbaEcho).toMatchObject({
      type: "agent_verified",
      operator: "openai",
      verification: "signature_valid",
      purpose: "user_directed",
    });

    const ipAgent = makeVerdict({
      verification: "ip_match",
      agent_purpose: "user_directed",
      verified: { operator: "anthropic", method: "ip", expiresAt: nowSec + 300 },
      claimed: { uaTokens: ["Claude-Agent"], signatureAgents: [] },
      reason: "verified",
    });
    const ipAgentEcho = verdictEcho(ipAgent, nowSec)!;
    expect(ipAgentEcho).toMatchObject({
      type: "agent_verified",
      operator: "anthropic",
      verification: "ip_match",
      purpose: "user_directed",
    });

    for (const [vv, expectedClaim] of [
      [wbaEcho, "server_signature"],
      [ipAgentEcho, "server_ip"],
    ] as const) {
      for (const reader of [legacy.createVerdictEcho, createVerdictEcho]) {
        const h = makeHost();
        const receive = reader(h, () => 1000);
        receive.consent(true);
        await receive(Response.json({ vv }), true);
        expect(h.dataLayer).toMatchObject([
          {
            event: "traffic_class",
            traffic_class: "declared_agent",
            traffic_agent: vv.operator,
            traffic_agent_claim: expectedClaim,
          },
        ]);
      }
    }

    // 3. Unverified taxonomy types never emit an echo and are rejected by both schema readers
    for (const unverified of [
      makeVerdict({}),
      makeVerdict({ claimed: { uaTokens: ["ChatGPT-User"], signatureAgents: [] } }),
      makeVerdict({ claimed: { uaTokens: ["Claude-Agent"], signatureAgents: [] } }),
      makeVerdict({ verification: "signature_invalid", reason: "signature_invalid" }),
    ]) {
      expect(verdictEcho(unverified, nowSec)).toBeUndefined();
    }
    for (const badType of ["unclassified", "crawler_unverified", "agent_unverified", "pending"]) {
      const payload = { ...fetcherEcho, type: badType };
      expect(serverVerdict(payload)).toBeUndefined();
      expect(legacy.serverVerdict(payload)).toBeUndefined();
    }
  });

  it("exposes all 10 vv_type counters in /health and echoes IP-verified fetcher safely on /e and /d", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const verdicts: library.AgentVerdict[] = [
      // hit 1: no signal -> unclassified (204)
      makeVerdict({}),
      // hit 2: unverified fetcher UA -> crawler_unverified (204)
      makeVerdict({ claimed: { uaTokens: ["ChatGPT-User"], signatureAgents: [] } }),
      // hit 3: IP-verified fetcher -> crawler_verified with user_directed in GA4, crawler in B7 echo (200)
      makeVerdict({
        verification: "ip_match",
        agent_purpose: "user_directed",
        verified: { operator: "openai", method: "ip", expiresAt: nowSec + 300 },
        claimed: { uaTokens: ["ChatGPT-User"], signatureAgents: [] },
        reason: "verified",
      }),
    ];
    let idx = 0;
    vi.mocked(library.createVerifier).mockReturnValue({
      verify: vi.fn(async () => verdicts[idx++]!),
      warm: vi.fn(async () => ({ ok: [], failed: [] })),
      close: vi.fn(),
      status: vi.fn(() => ({
        directories: { loaded: 9, total: 9 },
        ipLists: { loaded: 1, total: 1 },
        lastRefreshOk: true,
        lastRefreshAt: nowSec,
      })),
    });

    const sent: URLSearchParams[] = [];
    const app = createApp(
      {
        measurementId: "G-TEST",
        siteOrigin: "https://shop.example",
        cookieSecret: "s".repeat(64),
        agentVerification: true,
        trackerHost: "tracker.example",
      },
      async (url, init) => {
        sent.push(new URLSearchParams(new URL(String(url)).search + "&" + (init?.body ?? "")));
        return new Response(null, { status: 204 });
      },
    );
    apps.push(app);

    const now = Date.now();
    const postEvent = (clientId: string, ua: string) =>
      app.inject({
        method: "POST",
        url: "/e",
        headers: { origin: "https://shop.example", "user-agent": ua },
        payload: {
          name: "page_view",
          client_id: clientId,
          session_id: 1,
          page_id: "1",
          hit_index: 1,
          consent: { analytics_storage: "granted" },
          params: {},
          event_id: crypto.randomUUID(),
          timestamp_ms: now,
          session_started_ms: now,
          session_expires_ms: now + 1800000,
        },
      });

    const r1 = await postEvent("1.1", "Mozilla/5.0");
    expect(r1.statusCode).toBe(204);
    expect(sent[0]!.get("ep.vv_type")).toBe("unclassified");

    const r2 = await postEvent("2.1", "ChatGPT-User/1.0");
    expect(r2.statusCode).toBe(204);
    expect(sent[1]!.get("ep.vv_type")).toBe("crawler_unverified");

    const r3 = await postEvent("3.1", "ChatGPT-User/1.0");
    expect(r3.statusCode).toBe(200);
    expect(sent[2]!.get("ep.vv_type")).toBe("crawler_verified");
    expect(sent[2]!.get("ep.vv_detail")).toBe("openai|ip_match|user_directed|ua_token|-|-");
    expect(r3.json().vv).toMatchObject({
      v: 1,
      type: "crawler_verified",
      operator: "openai",
      verification: "ip_match",
      purpose: "crawler",
    });

    const health = (await app.inject("/health")).json();
    expect(Object.keys(health.agentVerification.counters.events.byType).sort()).toEqual(
      [...ALL_TEN_TYPES].sort(),
    );
    expect(Object.keys(health.agentVerification.counters.pings.byType).sort()).toEqual(
      [...ALL_TEN_TYPES].sort(),
    );
    expect("pending" in health.agentVerification.counters.events.byType).toBe(false);
    expect(health.agentVerification.counters.events.byType).toMatchObject({
      unclassified: 1,
      crawler_unverified: 1,
      crawler_verified: 1,
      agent_verified: 0,
      agent_unverified: 0,
    });
    expect(health.agentVerification.counters.events.total).toBe(3);
  });
});
