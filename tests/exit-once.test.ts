import { afterEach, expect, it, vi } from "vitest";
import { page } from "./browser-fixture.js";

afterEach(() => vi.useRealTimers());
const granted = {
  analytics_storage: "granted",
  ad_storage: "granted",
  ad_user_data: "granted",
  ad_personalization: "granted",
};
const exits = (p: ReturnType<typeof page>) =>
  p.fetcher.mock.calls
    .filter(([url]) => String(url).endsWith("/e"))
    .map(([, o]) => JSON.parse(String(o!.body)))
    .filter((e) => e.name === "page_engagement");

async function leave(order: ("pagehide" | "visibilitychange")[]) {
  vi.useFakeTimers();
  const p = page([["consent", "default", granted]]);
  (p.host.setInterval.mock.calls[0]![0] as () => void)();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  vi.advanceTimersByTime(4000);
  for (const name of order) {
    // A few milliseconds pass between the two events in a real browser.
    vi.advanceTimersByTime(3);
    if (name === "visibilitychange")
      (p.doc as { visibilityState: string }).visibilityState = "hidden";
    p[name === "pagehide" ? "host" : "doc"].dispatchEvent(new Event(name));
  }
  return exits(p);
}

it("leaving a page sends one page_engagement when pagehide comes before visibilitychange", async () => {
  const sent = await leave(["pagehide", "visibilitychange"]);
  expect(sent).toHaveLength(1);
  expect(sent[0].params.engagement_time_msec).toBe(4003);
});

it("leaving a page sends one page_engagement when visibilitychange comes before pagehide", async () => {
  const sent = await leave(["visibilitychange", "pagehide"]);
  expect(sent).toHaveLength(1);
  expect(sent[0].params.engagement_time_msec).toBe(4003);
});
