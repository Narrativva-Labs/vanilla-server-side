import { expect, it, vi } from "vitest";
import Fastify from "fastify";
import { visitorLabels, type AgentVerdict } from "visitor-verdict-server";
import { configFromEnv } from "../src/server/config.js";
import { createAgentLabeller } from "../src/server/agent-verification.js";
import { createLabelMemory } from "../src/server/labels.js";
import { createAgentCounters } from "../src/server/agent-counters.js";

it("validates the opt-in environment flag", () => {
  const env = { GA4_MEASUREMENT_ID: "G-TEST", COOKIE_SECRET: "s".repeat(64) };
  expect(configFromEnv(env).flagSpoofedClaims).toBe(false);
  expect(configFromEnv({ ...env, FLAG_SPOOFED_CLAIMS: "on" }).flagSpoofedClaims).toBe(true);
  expect(() => configFromEnv({ ...env, FLAG_SPOOFED_CLAIMS: "yes" })).toThrow("on or off");
});
for (const proxy of [false, true]) {
  it(`uses the Fastify-selected client IP with trusted proxy=${proxy}`, async () => {
    const fetcher = vi.fn(async (url: string) =>
      Response.json(
        url.includes(".json") ? { prefixes: [{ ipv4Prefix: "192.0.2.0/24" }] } : { keys: [] },
      ),
    );
    const labeller = createAgentLabeller("tracker.example", {
      fetcher,
      now: () => 1800000000,
      flagSpoofedClaims: true,
    });
    const app = Fastify({ trustProxy: proxy ? ["127.0.0.1"] : false });
    app.get("/", async (req) => {
      const verdict = await labeller.label(req);
      return { ip: req.ip, verdict, ...visitorLabels({ verdict }) };
    });
    try {
      // Full feed union loads at startup; requests are cache-only.
      await vi.waitFor(() =>
        expect(fetcher.mock.calls.some(([url]) => url === "https://openai.com/adsbot.json")).toBe(
          true,
        ),
      );
      const request = {
        method: "GET" as const,
        url: "/",
        remoteAddress: "127.0.0.1",
        headers: { "user-agent": "ChatGPT-User/1.0", "x-forwarded-for": "192.0.2.7" },
      };
      await vi.waitFor(async () => {
        const result = (await app.inject(request)).json();
        expect(result.ip).toBe(proxy ? "192.0.2.7" : "127.0.0.1");
        expect(result.verdict.verification).toBe(proxy ? "ip_match" : "ip_mismatch");
        expect(result.vv_type).toBe(proxy ? "crawler_verified" : "bot_spoofed");
      });
      const forged = (
        await app.inject({
          ...request,
          headers: { ...request.headers, "x-forwarded-for": "203.0.113.7" },
        })
      ).json();
      expect(forged.vv_detail).toBe("none|ip_mismatch|unknown|ua_token|-|-");
      expect(forged.verdict.ipTrusted).toBe(true);
    } finally {
      await app.close();
      labeller.close();
    }
  });
}
it("mismatch rank protects direct identity and counters retain current evidence", () => {
  const verdict: AgentVerdict = {
    verification: "ip_mismatch",
    reason: "official_ip_range_mismatch",
    agent_purpose: "unknown",
    ipTrusted: true,
    ipListsFresh: true,
    claimed: { uaTokens: ["ChatGPT-User"], signatureAgents: [] },
    signatures: [],
  };
  const spoof = visitorLabels({ verdict, browserClass: "automated" });
  const memory = createLabelMemory(10, 1000, () => 0);
  const direct = {
    vv_type: "agent_verified" as const,
    vv_detail: "openai|signature_valid|user_directed|signature_agent|-|-",
  };
  memory.apply("s", direct);
  expect(memory.apply("s", spoof)).toEqual({
    vv_type: "agent_verified",
    vv_detail: "openai|ip_mismatch|user_directed|ua_token|automated|-",
  });
  memory.apply("b", visitorLabels({ browserClass: "automated" }));
  expect(memory.apply("b", spoof).vv_type).toBe("bot_spoofed");
  expect(memory.apply("b", direct).vv_type).toBe("agent_verified");
  const counts = createAgentCounters();
  counts.observe("events", [])(spoof, verdict);
  expect(counts.counters.events.byVerification.ip_mismatch).toBe(1);
});

it("uncertain IP mismatch preserves browser automation and cannot raise session rank", () => {
  for (const ipTrusted of [true, false])
    for (const ipListsFresh of [true, false, undefined]) {
      const verdict: AgentVerdict = {
        verification: "ip_mismatch",
        reason: "official_ip_range_mismatch",
        agent_purpose: "unknown",
        ipTrusted,
        ipListsFresh,
        claimed: { uaTokens: ["ChatGPT-User"], signatureAgents: [] },
        signatures: [],
      };
      const certain = ipTrusted && ipListsFresh === true;
      expect(visitorLabels({ verdict }).vv_type).toBe(
        certain ? "bot_spoofed" : "crawler_unverified",
      );
      const labels = visitorLabels({ verdict, browserClass: "automated" });
      expect(labels.vv_type).toBe(certain ? "bot_spoofed" : "bot_automation");
      expect(labels.vv_detail.split("|")[1]).toBe("ip_mismatch");
      const memory = createLabelMemory(10, 1000, () => 0);
      memory.apply("s", visitorLabels({ browserClass: "automated" }));
      expect(memory.apply("s", visitorLabels({ verdict })).vv_type).toBe(
        certain ? "bot_spoofed" : "bot_automation",
      );
    }
});

it("collector ages failed source refreshes without waiting and accepts only non-WBA fallback", async () => {
  let now = 1800000000,
    fail = false;
  const fetcher = vi.fn(async (url: string) => {
    if (fail) return new Response(null, { status: 503 });
    return Response.json(
      url.includes(".json") ? { prefixes: [{ ipv4Prefix: "192.0.2.0/24" }] } : { keys: [] },
    );
  });
  const labeller = createAgentLabeller("tracker.example", {
    fetcher,
    now: () => now,
    flagSpoofedClaims: true,
  });
  const app = Fastify({ trustProxy: ["127.0.0.1"] });
  app.get("/", async (req) => {
    const verdict = await labeller.label(req);
    return { verdict, labels: visitorLabels({ verdict, browserClass: "automated" }) };
  });
  const request = {
    method: "GET" as const,
    url: "/",
    remoteAddress: "127.0.0.1",
    headers: {
      "user-agent": "ChatGPT-User/1.0",
      "x-forwarded-for": "203.0.113.7",
      signature: "other=:AAAA:",
      "signature-input": 'other=("@method");tag="other-protocol"',
    },
  };
  try {
    await vi.waitFor(async () =>
      expect((await app.inject(request)).json().labels.vv_type).toBe("bot_spoofed"),
    );
    const match = (
      await app.inject({
        ...request,
        headers: { ...request.headers, "x-forwarded-for": "192.0.2.1" },
      })
    ).json();
    expect(match.verdict.verification).toBe("ip_match");
    fail = true;
    now += 7201;
    const before = fetcher.mock.calls.length;
    const stale = (await app.inject(request)).json();
    expect(stale.verdict.verification).toBe("ip_mismatch");
    expect(stale.verdict.ipListsFresh).toBe(false);
    expect(stale.labels.vv_type).toBe("bot_automation");
    expect(fetcher.mock.calls.length).toBeGreaterThan(before);
    const repeated = (await app.inject(request)).json();
    expect(repeated.verdict.ipListsFresh).toBe(false);
    expect(repeated.labels.vv_type).toBe("bot_automation");
    const wba = (
      await app.inject({
        ...request,
        headers: { ...request.headers, "signature-input": 'other=("@method");tag="web-bot-auth"' },
      })
    ).json();
    expect(wba.verdict.verification).not.toBe("ip_mismatch");
  } finally {
    await app.close();
    labeller.close();
  }
});
