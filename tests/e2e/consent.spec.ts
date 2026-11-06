import { expect } from "@playwright/test";
import { test } from "./demo.js";

const noDecision = "no decision within 2 seconds";
const refused = "the visitor refused";

test("without a decision nothing leaves the browser", async ({ demo, page }) => {
  await demo.open();
  await page.getByRole("button", { name: "generate_lead" }).click();
  await page.getByRole("button", { name: "page_view" }).click();
  await demo.blocked("generate_lead", noDecision);
  await demo.blocked("page_view", noDecision);
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

test("rejecting sends one limited ping, no event and no cookie", async ({ demo, page }) => {
  await demo.open();
  await page.getByRole("button", { name: "Reject" }).click();
  await expect.poll(() => demo.sent()).toEqual([{ path: "/p" }]);

  await page.getByRole("button", { name: "generate_lead" }).click();
  await demo.blocked("generate_lead", refused);
  expect(demo.sent()).toEqual([{ path: "/p" }]);
  await expect.poll(() => demo.pings()).toBe(1);
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
