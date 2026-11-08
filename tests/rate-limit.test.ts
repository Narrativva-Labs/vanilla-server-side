import { afterEach, expect, it, vi } from "vitest";
import { createRateLimit } from "../src/server/rate-limit.js";

afterEach(() => vi.useRealTimers());

it("a busy address gets a fresh minute even while one of its requests is in flight", () => {
  vi.useFakeTimers();
  const limiter = createRateLimit();
  const held = limiter.claim("192.0.2.1");
  expect(held).toBeDefined();
  for (let i = 0; i < 299; i++) limiter.claim("192.0.2.1")!();
  expect(limiter.claim("192.0.2.1")).toBeUndefined();
  vi.advanceTimersByTime(61_000);
  // An office behind one address is never idle; its limit must still renew every minute.
  expect(limiter.claim("192.0.2.1")).toBeDefined();
  held!();
});

it("steady traffic below the limit is never refused", () => {
  vi.useFakeTimers();
  const limiter = createRateLimit();
  const held = limiter.claim("192.0.2.2");
  for (let minute = 0; minute < 5; minute++) {
    for (let i = 0; i < 250; i++) {
      const release = limiter.claim("192.0.2.2");
      expect(release, `minute ${minute}, request ${i}`).toBeDefined();
      release!();
    }
    vi.advanceTimersByTime(60_000);
  }
  held!();
});
it("one address holds up to 30 deliveries at once, then refuses until one finishes", () => {
  const limit = createRateLimit();
  const releases = Array.from({ length: 30 }, () => limit.claim("192.0.2.9"));
  expect(releases.every(Boolean)).toBe(true);
  expect(limit.claim("192.0.2.9")).toBeUndefined();
  expect(limit.claim("192.0.2.10")).toBeTruthy();
  releases[0]!();
  expect(limit.claim("192.0.2.9")).toBeTruthy();
});
