import { expect, it } from "vitest";
import { collectRequest } from "../src/server/google.js";

const labels = {
  "ep.vv_type": "agent_verified",
  "ep.vv_detail": "openai|signature_valid|user_directed|signature_agent|declared_agent|final",
};
const items = (body: URLSearchParams) => [...body].filter(([key]) => /^pr\d+$/.test(key));

it("trims items before labels when labels cross the body budget", () => {
  const url = new URL("https://www.google-analytics.com/g/collect?v=2&en=purchase");
  url.searchParams.set("ep.transaction_id", "ORDER-130");
  for (let i = 1; i <= 130; i++) url.searchParams.set(`pr${i}`, `id${i}~nm${"n".repeat(90)}`);
  const initial = collectRequest(url, true)!;
  const targetBytes = 16320;
  url.searchParams.set(
    "ep.padding",
    "x".repeat(targetBytes - Buffer.byteLength(initial.body!) - "&ep.padding=".length),
  );
  const baseline = collectRequest(url, true)!;
  expect(Buffer.byteLength(baseline.body!)).toBe(targetBytes);
  expect(items(new URLSearchParams(baseline.body))).toHaveLength(130);
  for (const [key, value] of Object.entries(labels)) url.searchParams.set(key, value);
  const result = collectRequest(url, true)!;
  expect(Buffer.byteLength(result.body!)).toBeLessThanOrEqual(16384);
  const body = new URLSearchParams(result.body);
  expect(items(body)).toHaveLength(129);
  expect(body.get("ep.transaction_id")).toBe("ORDER-130");
  for (const [key, value] of Object.entries(labels)) expect(body.get(key)).toBe(value);
});
