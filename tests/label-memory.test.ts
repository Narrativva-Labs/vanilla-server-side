import { expect, it, vi } from "vitest";
import { visitorLabels, type AgentVerdict } from "visitor-verdict-server";
import { createLabelMemory } from "../src/server/labels.js";
import { buildEventCollectUrl, sendDeniedPing } from "../src/server/google.js";
import { normalizeConsent } from "../src/shared/consent.js";
import type { TrackingEvent } from "../src/shared/event.js";

const verdict = (purpose: AgentVerdict["agent_purpose"]): AgentVerdict => ({
  verification: "signature_valid",
  agent_purpose: purpose,
  verified: { operator: "openai", method: "signature" },
  claimed: { uaTokens: [], signatureAgents: ["https://chatgpt.com"] },
  reason: "valid",
  signatures: [],
});
const labels = [
  visitorLabels(),
  visitorLabels({ browserClass: "human" }),
  visitorLabels({ browserClass: "suspicious" }),
  visitorLabels({ browserClass: "declared_agent" }),
  visitorLabels({ browserClass: "automated" }),
  visitorLabels({ verdict: verdict("crawler") }),
  visitorLabels({ verdict: verdict("user_directed") }),
  visitorLabels({ verdict: { ...verdict("unknown"), verification: "signature_invalid" } }),
];
for (let stronger = 0; stronger < labels.length; stronger++) {
  for (let weaker = 0; weaker < stronger; weaker++) {
    if ((stronger === 6 && weaker === 5) || (stronger === 7 && weaker >= 5)) continue;
    it(`retains rank ${stronger} over later rank ${weaker}`, () => {
      const memory = createLabelMemory();
      memory.apply("session", labels[stronger]!);
      expect(memory.apply("session", labels[weaker]!).vv_type).toBe(labels[stronger]!.vv_type);
    });
  }
}
it("uses current evidence, known operator and fresh equal-rank type", () => {
  const memory = createLabelMemory();
  memory.apply("s", labels[5]!);
  expect(memory.apply("s", labels[6]!).vv_type).toBe("agent_verified");
  expect(
    memory.apply("s", visitorLabels({ browserClass: "human", browserPhase: "final" })),
  ).toEqual({
    vv_type: "agent_verified",
    vv_detail: "openai|-|-|-|human|final",
  });
});
it("bounds the LRU, preserves proof expiry, sweeps and clears", () => {
  let now = 0;
  const memory = createLabelMemory(2, 100, () => now);
  memory.apply("a", labels[7]!);
  memory.apply("b", labels[7]!);
  now = 40;
  memory.apply("a", labels[1]!);
  memory.apply("c", labels[1]!);
  expect(memory.size).toBe(2);
  expect(memory.apply("b", labels[1]!).vv_type).toBe("human"); // b was evicted
  now = 140;
  expect(memory.apply("a", labels[1]!).vv_type).toBe("human");
  now = 240;
  memory.sweep();
  expect(memory.size).toBe(0);
  memory.apply("s", labels[1]!);
  memory.clear();
  expect(memory.size).toBe(0);
});
it("validates the sticky detail at the longest configured operator and evidence", () => {
  const memory = createLabelMemory();
  memory.apply(
    "s",
    visitorLabels({
      verdict: {
        ...verdict("user_directed"),
        verified: { operator: "a".repeat(24), method: "signature" },
      },
    }),
  );
  const result = memory.apply(
    "s",
    visitorLabels({
      verdict: { ...verdict("unknown"), verification: "signature_invalid" },
      browserClass: "declared_agent",
      browserPhase: "initial",
    }),
  );
  expect(result.vv_detail.startsWith("a".repeat(24) + "|")).toBe(true);
  expect(result.vv_detail.length).toBeLessThanOrEqual(100);
});
const destination = { measurementId: "G-TEST" };
const event = (client_id = "123.456", session_id = 1): TrackingEvent => {
  const now = Date.now();
  return {
    event_id: crypto.randomUUID(),
    name: "purchase",
    client_id,
    session_id,
    session_started_ms: now,
    session_expires_ms: now + 1800000,
    timestamp_ms: now,
    consent: normalizeConsent({ analytics_storage: "granted" }),
    params: { traffic_class: "human" },
  };
};
it("keeps full-event memory isolated by both client and session", () => {
  const memory = createLabelMemory();
  buildEventCollectUrl(
    destination,
    event(),
    normalizeConsent({ analytics_storage: "granted" }),
    undefined,
    verdict("user_directed"),
    memory,
  );
  expect(
    buildEventCollectUrl(
      destination,
      event(),
      normalizeConsent({ analytics_storage: "granted" }),
      undefined,
      undefined,
      memory,
    )?.searchParams.get("ep.vv_type"),
  ).toBe("agent_verified");
  for (const e of [event("789.123"), event("123.456", 2)])
    expect(
      buildEventCollectUrl(
        destination,
        e,
        normalizeConsent({ analytics_storage: "granted" }),
        undefined,
        undefined,
        memory,
      )?.searchParams.get("ep.vv_type"),
    ).toBe("human");
});
it("keeps denied pings sticky only within a page, ignoring shared session IDs", async () => {
  const memory = createLabelMemory();
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const ping = (page_id: string, traffic_class: string) => ({
    consent: normalizeConsent({}),
    name: "purchase",
    params: { traffic_class },
    client_id: "1.2",
    session_id: 1,
    page_id,
    hit_index: 1,
  });
  for (const p of [ping("page-a", "automated"), ping("page-b", "human"), ping("page-a", "human")])
    await sendDeniedPing(destination, p, undefined, fetcher, undefined, undefined, memory);
  expect(
    fetcher.mock.calls.map(([url]) => new URL(String(url)).searchParams.get("ep.vv_type")),
  ).toEqual(["bot_automation", "human", "bot_automation"]);
});

it("uses fresh crawler_verified evidence at equal rank", () => {
  const memory = createLabelMemory();
  memory.apply("s", labels[6]!);
  expect(memory.apply("s", labels[5]!).vv_type).toBe("crawler_verified");
});
