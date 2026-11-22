import { expect, it } from "vitest";
import type { AgentVerdict } from "visitor-verdict-server";
import { createLabelMemory, withLabels } from "../src/server/labels.js";

// Evidence versus identity: an operator in vv_detail is either verified (and then the type,
// also when carried in session memory, is agent_verified or crawler_verified) or named by a
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
];
const browser = [
  {},
  { traffic_class: "human", traffic_phase: "final" },
  { traffic_class: "automated", traffic_phase: "initial" },
  { traffic_class: "declared_agent", traffic_phase: "agent", traffic_agent: "openai" },
  { traffic_class: "declared_agent", traffic_phase: "agent", traffic_agent: "anthropic" },
  { traffic_class: "declared_agent", traffic_phase: "initial" },
];

function check(labels: Record<string, unknown>) {
  const type = labels.vv_type as string;
  const [operator, verification] = (labels.vv_detail as string).split("|");
  if (operator === "none") return;
  if (type === "agent_verified" || type === "crawler_verified") return;
  // Not verified: the only remaining source is a page marker, current or carried.
  expect(type).toBe("agent_unverified");
  expect(["openai", "anthropic"]).toContain(operator);
  expect(["signature_valid", "ip_match"]).not.toContain(verification);
}

it("every operator states its source on single hits and in deterministic session sequences", () => {
  let seed = 7;
  const random = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (const v of verdicts) for (const b of browser) check(withLabels({ ...b }, v));
  for (let run = 0; run < 300; run++) {
    let time = 1_000_000;
    const memory = createLabelMemory(10, 60_000, () => time);
    for (let hit = 0; hit < 8; hit++) {
      time += 1000;
      const v = verdicts[random(verdicts.length)];
      const out = withLabels({ ...browser[random(browser.length)] }, v, {
        memory,
        key: "session",
      });
      check(out);
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
    vv_type: "agent_verified",
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
    vv_type: "agent_verified",
    vv_detail: "browserbase|no_signature|unknown|ua_token|declared_agent|agent",
  });
});
