import { expect } from "@playwright/test";
import { test } from "./demo.js";

const noDecision = "no decision yet";
const refused = "the visitor refused";

test("without a decision event pings leave while full events wait", async ({ demo, page }) => {
  await demo.open();
  await page.getByRole("button", { name: "generate_lead" }).click();
  await page.getByRole("button", { name: "page_view" }).click();
  await demo.blocked("generate_lead", noDecision);
  await demo.blocked("page_view", noDecision);
  await expect.poll(() => demo.pings()).toBe(3);
  expect(demo.sent()).toEqual([]);
  expect(demo.toGoogle("generate_lead")).toBe(0);
  expect(demo.toGoogle("page_view")).toBe(0);
  expect(await demo.session()).toBeUndefined();
});

test("accepting sends the page view and sets an HttpOnly cookie", async ({ demo, page }) => {
  await demo.open();
  await page.getByRole("button", { name: "Accept" }).click();
  await expect.poll(() => demo.toGoogle("page_view")).toBe(1);
  await expect.poll(demo.session).toMatchObject({ httpOnly: true, sameSite: "Lax" });
  expect(await page.evaluate(() => document.cookie)).not.toContain("vanilla_session");

  await page.getByRole("button", { name: "generate_lead" }).click();
  await expect.poll(() => demo.toGoogle("generate_lead")).toBe(1);
  expect(demo.sent().map(({ path }) => path)).toEqual(["/e", "/e"]);
});

test("rejecting keeps event pings enabled without full events or cookies", async ({
  demo,
  page,
}) => {
  await demo.open();
  await page.getByRole("button", { name: "Reject" }).click();
  await expect.poll(() => demo.sent()).toEqual([{ path: "/p" }]);

  await page.getByRole("button", { name: "generate_lead" }).click();
  await demo.blocked("generate_lead", refused);
  expect(demo.sent()).toEqual([{ path: "/p" }]);
  await expect.poll(() => demo.pings()).toBe(2);
  expect(demo.toGoogle("generate_lead")).toBe(0);
  expect(await demo.session()).toBeUndefined();
});

test("withdrawing deletes the cookie and stops the events", async ({ demo, page }) => {
  await demo.open();
  await page.getByRole("button", { name: "Accept" }).click();
  await expect.poll(demo.session).toBeDefined();

  await page.getByRole("button", { name: "Withdraw" }).click();
  await expect.poll(demo.session).toBeUndefined();
  await page.getByRole("button", { name: "generate_lead" }).click();
  await demo.blocked("generate_lead", refused);
  expect(demo.sent().map(({ path }) => path)).toEqual(["/e", "/p"]);
  expect(demo.toGoogle("generate_lead")).toBe(0);
  expect(await demo.session()).toBeUndefined();
});

test("a SPA navigation sends one page view", async ({ demo, page }) => {
  await demo.open();
  await page.getByRole("button", { name: "Accept" }).click();
  await expect.poll(() => demo.toGoogle("page_view")).toBe(1);

  // The button pushes /page-2. Repeating that address is no navigation, so nothing more goes out.
  await page.getByRole("button", { name: "page_view" }).click();
  await page.evaluate(() => {
    history.replaceState({}, "", location.href);
    history.pushState({}, "", location.href);
  });
  await page.goBack();
  await page.goBack();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/");

  // Delivery keeps its order, so a duplicate would arrive before this event.
  await page.getByRole("button", { name: "generate_lead" }).click();
  await expect.poll(() => demo.toGoogle("generate_lead")).toBe(1);
  expect(demo.toGoogle("page_view")).toBe(3);
  expect(demo.sent().filter(({ name }) => name === "page_view")).toHaveLength(3);
});

for (const [name, failure] of [
  ["errors", { status: 503 }],
  ["a slow answer", { status: 204, delay: 1500 }],
] as const)
  test(`a collector with ${name} does not block the page`, async ({ demo, page }) => {
    await demo.open();
    await page.route("**/e", async (route) => {
      if ("delay" in failure) await new Promise((done) => setTimeout(done, failure.delay));
      await route.fulfill({ status: failure.status });
    });
    await page.getByRole("button", { name: "Accept" }).click();
    await page.getByRole("button", { name: "generate_lead" }).click();
    await page.getByRole("button", { name: "purchase" }).click();
    // The longest gap between timer ticks shows whether the main thread stayed free.
    const longest = await page.evaluate(
      () =>
        new Promise<number>((done) => {
          let last = performance.now();
          let worst = 0;
          const timer = setInterval(() => {
            const now = performance.now();
            worst = Math.max(worst, now - last);
            last = now;
          }, 20);
          setTimeout(() => {
            clearInterval(timer);
            done(worst);
          }, 3500);
        }),
    );
    expect(longest).toBeLessThan(500);
  });

test("an unreachable tracker does not hold the page", async ({ page, demo }) => {
  // A server that is switched off never answers; the page must not wait for it.
  await page.route("**/s.js", () => new Promise(() => {}));
  await demo.open("commit");
  await page.waitForFunction(
    () =>
      (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming)
        ?.domContentLoadedEventEnd > 0,
    null,
    { timeout: 3000 },
  );
  await page.getByRole("button", { name: "Accept" }).click({ timeout: 3000 });
  await expect(page.locator("#state")).toHaveText("granted");
});

for (const choice of ["Accept", "Reject"]) {
  test(`a hidden-page detector final sends one class update with ${choice}`, async ({
    demo,
    page,
  }) => {
    await demo.open();
    await page.getByRole("button", { name: choice }).click();
    if (choice === "Accept") await expect.poll(demo.session).toBeDefined();
    const updates: { path: string; params: Record<string, unknown> }[] = [];
    page.on("request", (request) => {
      const data = request.method() === "POST" ? request.postDataJSON() : undefined;
      if (data?.name === "traffic_class")
        updates.push({ path: new URL(request.url()).pathname, params: data.params });
    });
    await page.evaluate(() => {
      const host = window as unknown as { dataLayer: unknown[] };
      // Synthetic detector contract: the publication happens during the hidden transition.
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      const final = {
        event: "traffic_class",
        traffic_class: "suspicious",
        traffic_phase: "final",
        traffic_score: 6,
        traffic_signals: ["UB"],
      };
      host.dataLayer.push(final, final);
      window.dispatchEvent(new Event("pagehide"));
    });
    await expect.poll(() => updates.length).toBe(1);
    expect(updates[0]).toEqual({
      path: choice === "Accept" ? "/e" : "/d",
      params: {
        traffic_class: "suspicious",
        traffic_phase: "final",
        page_location: expect.stringMatching(/^http:\/\/localhost:\d+\/$/),
        page_referrer: "",
        page_title: "Vanilla Server-Side demo",
      },
    });
    if (choice === "Accept") await expect.poll(() => demo.toGoogle("traffic_class")).toBe(1);
    else expect(await demo.session()).toBeUndefined();
  });
}
