import { afterEach, expect, it, vi } from "vitest";
import { page } from "./browser-fixture.js";

afterEach(() => vi.useRealTimers());
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const flushPage = async (p: ReturnType<typeof page>) => {
  (p.host.setInterval.mock.calls[0]![0] as () => void)();
  await settle();
};
const sent = (p: ReturnType<typeof page>) =>
  p.fetcher.mock.calls
    .filter(([url]) => String(url).endsWith("/e"))
    .map(([, o]) => JSON.parse(String(o!.body)));
const all = {
  analytics_storage: "granted",
  ad_storage: "granted",
  ad_user_data: "granted",
  ad_personalization: "granted",
};
const deniedDefault = [
  "consent",
  "default",
  {
    analytics_storage: "denied",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  },
];
const list = {
  event: "view_item_list",
  ecommerce: { item_list_id: "home", items: [{ item_id: "apple" }] },
};

it("an event before the banner click is sent once the visitor accepts, even much later", async () => {
  vi.useFakeTimers();
  const p = page([deniedDefault, list]);
  vi.advanceTimersByTime(30_000);
  await flushPage(p);
  expect(sent(p)).toEqual([]);
  p.command("consent", "update", all);
  await flushPage(p);
  await flushPage(p);
  const events = sent(p);
  expect(events.map((e) => e.name)).toEqual(["page_view", "view_item_list"]);
  const held = events[1];
  expect(held.consent.analytics_storage).toBe("granted");
  // Advertising permission stays as it was when the event happened.
  expect(held.consent.ad_user_data).toBe("denied");
  expect(held.params.item_list_id).toBe("home");
});

it("an event before the banner click is dropped when the visitor refuses", async () => {
  vi.useFakeTimers();
  const p = page([deniedDefault, list]);
  vi.advanceTimersByTime(5_000);
  p.command("consent", "update", { analytics_storage: "denied" });
  await flushPage(p);
  p.command("consent", "update", all);
  await flushPage(p);
  await flushPage(p);
  expect(sent(p).map((e) => e.name)).toEqual(["page_view"]);
});

it("with no consent signal at all, an event waits for the first decision", async () => {
  vi.useFakeTimers();
  const p = page([list]);
  vi.advanceTimersByTime(20_000);
  await flushPage(p);
  expect(sent(p)).toEqual([]);
  p.command("consent", "update", all);
  await flushPage(p);
  await flushPage(p);
  expect(sent(p).map((e) => e.name)).toEqual(["page_view", "view_item_list"]);
});

it("a visitor who never decides sends nothing", async () => {
  vi.useFakeTimers();
  const p = page([deniedDefault, list, { event: "add_to_cart" }]);
  for (let i = 0; i < 5; i++) {
    vi.advanceTimersByTime(10_000);
    await flushPage(p);
  }
  expect(sent(p)).toEqual([]);
  expect(p.fetcher.mock.calls.every(([url]) => String(url).endsWith("/d"))).toBe(true);
});

it("a stored grant restored before the event sends it at once", async () => {
  const p = page([deniedDefault, ["consent", "update", all], list]);
  await settle();
  await flushPage(p);
  expect(sent(p).map((e) => e.name)).toEqual(["page_view", "view_item_list"]);
});
