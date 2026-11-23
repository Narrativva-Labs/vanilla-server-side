import { expect, it } from "vitest";
import type { AgentVerdict } from "visitor-verdict-server";
import { createLabelMemory, withLabels } from "../src/server/labels.js";

// Evidence versus identity: an operator in vv_detail is either verified (and then the type,
// also when carried in session memory, is agent_verified, automation_verified or crawler_verified) or named by a
// browser page marker (type agent_unverified). A UA token never names an operator.
const signed = (
  operator: string,
  purpose: AgentVerdict["agent_purpose"],
  signatureAgent: string,
): AgentVerdict => ({
  verification: "signature_valid",
  agent_purpose: purpose,
  verified: { operator, method: "signature", signatureAgent },
  claimed: { uaTokens: [], signatureAgents: [signatureAgent] },
  reason: "verified",
  signatures: [],
});
const verdicts: (AgentVerdict | undefined)[] = [
  undefined,
  signed("openai", "user_directed", "https://chatgpt.com"),
  signed("browserbase", "intermediary", "https://www.browserbase.com"),
  signed("meta", "user_directed", "https://muse.ai"),
  {
    verification: "ip_match",
    agent_purpose: "crawler",
    verified: { operator: "openai", method: "ip" },
    ip: { operator: "openai", list: "gptbot" },
    claimed: { uaTokens: ["GPTBot"], signatureAgents: [] },
    reason: "official_ip_range_match",
    signatures: [],
  },
  {
    verification: "no_signature",
    agent_purpose: "unknown",
    claimed: { uaTokens: ["ChatGPT-User"], signatureAgents: [] },
    reason: "signature_headers_absent",
    signatures: [],
  },
  {
    verification: "signature_invalid",
    agent_purpose: "unknown",
    claimed: { uaTokens: [], signatureAgents: ["https://muse.ai"] },
    reason: "crypto_mismatch",
    signatures: [],
  },
  {
    verification: "none",
    agent_purpose: "unknown",
    claimed: { uaTokens: [], signatureAgents: ["https://evil.example"] },
    reason: "untrusted_signature_agent",
    signatures: [],
  },
  {
    verification: "signature_invalid",
    agent_purpose: "unknown",
    claimed: { uaTokens: [], signatureAgents: ["https://chatgpt.com"] },
    reason: "replay",
    signatures: [{ label: "a", result: "signature_invalid", reason: "replay" }],
  },
  {
    ...signed("meta", "user_directed", "https://muse.ai"),
    agent_purpose: "invalid" as AgentVerdict["agent_purpose"],
  },
];
const browser = [
  {},
  { traffic_class: "suspicious", traffic_phase: "final" },
  { traffic_class: "declared_agent", traffic_phase: "agent", traffic_agent: "google" },
  { traffic_class: "human", traffic_phase: "final" },
  { traffic_class: "automated", traffic_phase: "initial" },
  { traffic_class: "declared_agent", traffic_phase: "agent", traffic_agent: "openai" },
  { traffic_class: "declared_agent", traffic_phase: "agent", traffic_agent: "anthropic" },
  { traffic_class: "declared_agent", traffic_phase: "initial" },
  {
    traffic_class: "declared_agent",
    traffic_phase: "agent",
    traffic_agent: "openai",
    traffic_agent_claim: "dom_host",
  },
  {
    traffic_class: "declared_agent",
    traffic_phase: "agent",
    traffic_agent: "anthropic",
    traffic_agent_claim: "dom_host",
  },
];

function check(
  labels: Record<string, unknown>,
  allowedVerified: Map<string, string>,
  markerOperators: Set<string>,
) {
  const type = labels.vv_type as string;
  const [operator, verification, purpose, claim] = (labels.vv_detail as string).split("|");
  expect((labels.vv_detail as string).length).toBeLessThanOrEqual(100);
  if (operator === "none") return;
  if (type === "agent_verified" || type === "crawler_verified" || type === "automation_verified") {
    expect(allowedVerified.has(operator!)).toBe(true);
    expect(purpose).toBe(allowedVerified.get(operator!));
    expect(["dom_marker", "dom_host"]).not.toContain(claim);
    return;
  }
  expect(type).toBe("agent_unverified");
  expect(markerOperators.has(operator!)).toBe(true);
  expect(["signature_valid", "ip_match"]).not.toContain(verification);
}
function remember(
  v: AgentVerdict | undefined,
  b: Record<string, unknown>,
  verified: Map<string, string>,
  markers: Set<string>,
) {
  if (v?.verified && ["signature_valid", "ip_match"].includes(v.verification))
    verified.set(
      v.verified.operator,
      ["user_directed", "crawler", "intermediary"].includes(v.agent_purpose)
        ? v.agent_purpose
        : "unknown",
    );
  if (
    b.traffic_class === "declared_agent" &&
    ["openai", "anthropic"].includes(String(b.traffic_agent))
  )
    markers.add(String(b.traffic_agent));
}

it("every operator states its source on single hits and in deterministic session sequences", () => {
  let seed = 7;
  const random = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (const v of verdicts)
    for (const b of browser) {
      const verified = new Map<string, string>();
      const markers = new Set<string>();
      remember(v, b, verified, markers);
      check(withLabels({ ...b }, v), verified, markers);
    }
  for (let run = 0; run < 300; run++) {
    let time = 1_000_000;
    const memory = createLabelMemory(10, 60_000, () => time);
    const verified = new Map<string, string>();
    const markers = new Set<string>();
    for (let hit = 0; hit < 8; hit++) {
      time += 1000;
      const v = verdicts[random(verdicts.length)];
      const b = browser[random(browser.length)]!;
      remember(v, b, verified, markers);
      const out = withLabels({ ...b }, v, {
        memory,
        key: "session",
      });
      check(out, verified, markers);
    }
  }
});

it("an intermediary stays infrastructure and is never replaced by a marker or a UA claim", () => {
  let time = 1_000_000;
  const memory = createLabelMemory(10, 60_000, () => time);
  const sticky = { memory, key: "session" };
  const browserbase = signed("browserbase", "intermediary", "https://www.browserbase.com");
  expect(
    withLabels({ traffic_class: "human", traffic_phase: "final" }, browserbase, sticky),
  ).toEqual({
    vv_type: "automation_verified",
    vv_detail: "browserbase|signature_valid|intermediary|signature_agent|human|final",
  });
  time += 1000;
  expect(
    withLabels(
      { traffic_class: "declared_agent", traffic_phase: "agent", traffic_agent: "openai" },
      verdicts[5],
      sticky,
    ),
  ).toEqual({
    vv_type: "automation_verified",
    vv_detail: "browserbase|no_signature|intermediary|ua_token|declared_agent|agent",
  });
});

it("a later intermediary never replaces an active direct identity or extends its proof", () => {
  let time = 1_000_000;
  const memory = createLabelMemory(10, 60_000, () => time);
  const sticky = { memory, key: "s" };
  const direct = signed("meta", "user_directed", "https://muse.ai");
  direct.verified!.expiresAt = 1005;
  const infra = signed("browserbase", "intermediary", "https://www.browserbase.com");
  for (const v of [direct, infra, undefined]) {
    const out = withLabels({ traffic_class: "human" }, v, sticky);
    expect(out.vv_type).toBe("agent_verified");
    expect(
      String(out.vv_detail)
        .split("|")
        .filter((_, i) => i === 0 || i === 2),
    ).toEqual(["meta", "user_directed"]);
    time += 1000;
  }
  time = 1_005_000;
  expect(withLabels({ traffic_class: "human" }, undefined, sticky).vv_type).toBe("human");
  expect(
    String(withLabels({}, infra, sticky).vv_detail)
      .split("|")
      .slice(0, 3),
  ).toEqual(["browserbase", "signature_valid", "intermediary"]);
  expect(String(withLabels({}, direct, sticky).vv_detail).split("|")[0]).toBe("meta");
});

it("replay does not inherit verified identity or clear its memory", () => {
  for (const v of [
    signed("meta", "user_directed", "https://muse.ai"),
    signed("browserbase", "intermediary", "https://www.browserbase.com"),
  ]) {
    const memory = createLabelMemory();
    const sticky = { memory, key: "s" };
    withLabels({}, v, sticky);
    const replay: AgentVerdict = {
      ...v,
      verified: undefined,
      agent_purpose: "unknown",
      verification: "none",
      reason: "replay",
      signatures: [
        { label: "a", result: "none", reason: "replay" },
        { label: "b", result: "signature_valid", reason: "verified" },
      ],
    };
    const replayLabels = withLabels(
      { traffic_class: "declared_agent", traffic_agent: "openai" },
      replay,
      sticky,
    );
    expect(replayLabels.vv_type).toBe("agent_unverified");
    expect(String(replayLabels.vv_detail).split("|")[0]).toBe("openai");
    expect(String(replayLabels.vv_detail).split("|")[3]).toBe("dom_marker");
    expect(String(withLabels({}, undefined, sticky).vv_detail).split("|")[0]).toBe(
      v.verified!.operator,
    );
  }
});
