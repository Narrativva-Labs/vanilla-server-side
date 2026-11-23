import { afterEach, expect, it, vi } from "vitest";
import * as verdict from "visitor-verdict-server";
import { collectRequest } from "../src/server/google.js";
import { validateParams } from "../src/server/mp-validation.js";
import { createAgentLabeller } from "../src/server/agent-verification.js";

vi.mock("visitor-verdict-server", async (importOriginal) => {
  const actual = await importOriginal<typeof verdict>();
  return { ...actual, createVerifier: vi.fn(actual.createVerifier) };
});
afterEach(() => vi.restoreAllMocks());

const labels = {
  "ep.vv_type": "agent_verified",
  "ep.vv_detail": "openai|signature_valid|user_directed|signature_agent|declared_agent|final",
};

it("keeps labels on a long URL whose body is far below 16 KiB", () => {
  const url = new URL("https://www.google-analytics.com/g/collect?v=2&en=page_view");
  url.searchParams.set("ep.payload", "x".repeat(3000));
  for (const [k, v] of Object.entries(labels)) url.searchParams.set(k, v);
  const body = new URLSearchParams(collectRequest(url, true)!.body);
  for (const k of Object.keys(labels)) expect(body.has(k)).toBe(true);
});

it("keeps labels while trimming an oversized item list", () => {
  const url = new URL("https://www.google-analytics.com/g/collect?v=2&en=purchase");
  url.searchParams.set("ep.transaction_id", "T1");
  url.searchParams.set("epn.value", "1234.5");
  url.searchParams.set("cu", "CZK");
  for (const [k, v] of Object.entries(labels)) url.searchParams.set(k, v);
  for (let i = 1; i <= 150; i++) url.searchParams.set(`pr${i}`, `id${i}~nm${"n".repeat(120)}`);
  const request = collectRequest(url, true)!;
  const body = new URLSearchParams(request.body);
  expect(body.get("ep.transaction_id")).toBe("T1");
  for (const k of Object.keys(labels)) expect(body.has(k)).toBe(true);
  expect(request.body).toBeDefined();
  expect(Buffer.byteLength(request.body!)).toBeLessThanOrEqual(16_384);
  expect(body.get("epn.value")).toBe("1234.5");
  expect(new URL(request.url).searchParams.get("cu")).toBe("CZK");
  const items = [...body].filter(([key]) => /^pr\d+$/.test(key));
  expect(items).toHaveLength(119);
  expect(items).toEqual(
    Array.from({ length: 119 }, (_, i) => [`pr${i + 1}`, `id${i + 1}~nm${"n".repeat(120)}`]),
  );
});

it("validateParams keeps agent labels ahead of many custom params on its own", () => {
  const input: Record<string, unknown> = {};
  for (let i = 0; i < 30; i++) input[`custom_${i}`] = i;
  input.vv_type = "agent_verified";
  input.vv_detail = "none|-|-|-|human|final";
  const out = validateParams(input, () => {});
  expect(out.vv_type).toBe("agent_verified");
  expect(out.vv_detail).toBe("none|-|-|-|human|final");
});

const fake = (reason: string) =>
  ({
    verify: vi.fn(async () => ({
      agent_purpose: "unknown",
      claimed: { uaTokens: [], signatureAgents: [] },
      verification: "none",
      reason,
      signatures: [],
    })),
    warm: vi.fn(async () => ({ ok: [], failed: [] })),
    close: vi.fn(),
    status: vi.fn(),
  }) as unknown as verdict.AgentVerifier;
const req = { method: "POST", raw: { rawHeaders: [] }, ip: "192.0.2.1", url: "/e" } as never;

for (const reason of ["ip_evidence_unavailable", "deadline_exceeded", "directory_timeout"] as const)
  it(`adds no labels for an incomplete verdict (${reason})`, async () => {
    vi.mocked(verdict.createVerifier).mockReturnValue(fake(reason));
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { label } = createAgentLabeller("t.example", {});
    expect(await label(req)).toMatchObject({ verification: "none", reason });
  });

it("the verifier trusts only the configured tracker host", () => {
  vi.mocked(verdict.createVerifier).mockReturnValue(fake("cache_miss"));
  vi.spyOn(console, "info").mockImplementation(() => {});
  createAgentLabeller("t.example", {});
  expect(vi.mocked(verdict.createVerifier).mock.calls.at(-1)![0].authorities).toEqual([
    "t.example",
  ]);
});
