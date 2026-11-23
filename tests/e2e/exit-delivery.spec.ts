import { expect } from "@playwright/test";
import { test } from "./demo.js";

// The collector receives the opener, but the browser cannot resume its queue before navigation.
// Check delivery at the local Google stub after the old document has actually gone away.
test("pagehide hands a queued purchase and class update to transport before document destruction", async ({
  demo,
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/e", async (route) => {
    if (route.request().postDataJSON()?.name !== "page_view") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    await gate;
    try {
      await route.fulfill({ response });
    } catch (error) {
      // Navigation may cancel the now-unneeded opener response after the keepalive hits arrived.
      if (page.url() !== "about:blank") throw error;
    }
  });
  try {
    await demo.open();
    await page.getByRole("button", { name: "Accept" }).click();
    await expect.poll(() => demo.toGoogle("page_view")).toBe(1);
    await page.evaluate(() => {
      const layer = (window as unknown as { dataLayer: Record<string, unknown>[] }).dataLayer;
      layer.push(
        { event: "purchase", transaction_id: "exit-one", value: 10, currency: "EUR" },
        { event: "traffic_class", traffic_class: "automated", traffic_phase: "final" },
      );
    });
    expect(demo.toGoogle("purchase")).toBe(0);
    expect(demo.toGoogle("traffic_class")).toBe(0);
    await page.goto("about:blank");
    await expect.poll(() => demo.toGoogle("purchase")).toBe(1);
    await expect.poll(() => demo.toGoogle("traffic_class")).toBe(1);
  } finally {
    release();
  }
});
