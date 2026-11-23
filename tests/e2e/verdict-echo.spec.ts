import { expect } from "@playwright/test";
import { test } from "./demo.js";

// Simulate the collector's verified response at the HTTP boundary. Real verification
// (fake verifier and captured signed requests) is covered by agent-verification.test.ts.
test("verified collector response publishes an agent phase without a feedback hit", async ({
  demo,
  page,
}) => {
  let requests = 0;
  await page.route("**/e", async (route) => {
    requests++;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        vv: {
          v: 1,
          ttl: 1800,
          type: "agent_verified",
          operator: "openai",
          verification: "signature_valid",
          purpose: "user_directed",
        },
      }),
    });
  });
  // Demo has verification disabled; enable the client response consumer for this fixture.
  await page.route("**/s.js", async (route) => {
    const original = await route.fetch();
    await route.fulfill({
      response: original,
      body: 'document.currentScript.dataset.verdictEcho="on";\n' + (await original.text()),
    });
  });
  await demo.open();
  await page.getByRole("button", { name: "Accept" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { dataLayer: Record<string, unknown>[] }).dataLayer.filter(
          (x) => x.traffic_source === "vanilla",
        ),
      ),
    )
    .toEqual([
      {
        event: "traffic_class",
        traffic_class: "declared_agent",
        traffic_phase: "agent",
        traffic_agent: "openai",
        traffic_agent_claim: "server_signature",
        traffic_source: "vanilla",
      },
    ]);
  expect(requests).toBe(1);
  await page.getByRole("button", { name: "generate_lead" }).click();
  await expect.poll(() => requests).toBe(2);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { dataLayer: Record<string, unknown>[] }).dataLayer.filter(
          (x) => x.traffic_source === "vanilla",
        ).length,
    ),
  ).toBe(1);
});
