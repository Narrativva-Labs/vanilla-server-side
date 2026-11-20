import { afterEach, expect, it, vi } from "vitest";
import * as library from "visitor-verdict-server";
import { createApp } from "../src/server/app.js";
import { createAgentLabeller } from "../src/server/agent-verification.js";

vi.mock("visitor-verdict-server", async (importOriginal) => {
  const actual = await importOriginal<typeof library>();
  return { ...actual, createVerifier: vi.fn(actual.createVerifier) };
});
const actual = await vi.importActual<typeof library>("visitor-verdict-server");
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
  vi.mocked(library.createVerifier).mockImplementation(actual.createVerifier);
  vi.useRealTimers();
});
const config = {
  cookieSecret: "s".repeat(64),
  measurementId: "G-TEST",
  siteOrigin: "https://shop.example",
  trackerHost: "operability.example:8443",
};

it("flag off has explicit disabled health and no startup verification log", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const app = createApp({ ...config, agentVerification: false });
  apps.push(app);
  expect((await app.inject("/health")).json().agentVerification).toEqual({
    enabled: false,
    directoriesLoaded: "0/0",
    lastRefreshOk: null,
  });
  expect(info).not.toHaveBeenCalled();
});
it("startup is logged once and /health shows cache progress and failures without visitor data", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let warming!: Promise<library.WarmResult>;
  vi.mocked(library.createVerifier).mockImplementation((options) => {
    const verifier = actual.createVerifier(options);
    return {
      ...verifier,
      warm: (options) => {
        warming = verifier.warm(options);
        return warming;
      },
    };
  });
  const app = createApp({ ...config, agentVerification: true }, fetch, {
    fetcher: async () => {
      await gate;
      throw Error("transport detail must not be logged");
    },
  });
  apps.push(app);
  const health = (await app.inject("/health")).json().agentVerification;
  expect(health).toEqual({ enabled: true, directoriesLoaded: "0/5", lastRefreshOk: null });
  finish();
  await warming;
  expect((await app.inject("/health")).json().agentVerification).toEqual({
    enabled: true,
    directoriesLoaded: "0/5",
    lastRefreshOk: false,
  });
  expect(info).toHaveBeenCalledExactlyOnceWith(
    "Agent verification on for operability.example:8443",
  );
  expect(Object.keys(health)).toEqual(["enabled", "directoriesLoaded", "lastRefreshOk"]);
});
it("directory, IP and SAIL warnings share one ten-minute limit per configured host", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1800000000000);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  const callbacks: NonNullable<library.VerifierOptions["onRefresh"]>[] = [];
  vi.mocked(library.createVerifier).mockImplementation((options) => {
    callbacks.push(options.onRefresh!);
    return {
      verify: vi.fn(),
      warm: vi.fn(async () => ({ ok: [], failed: [] })),
      close: vi.fn(),
      status: vi.fn(() => ({
        directories: { loaded: 0, total: 5 },
        ipLists: { loaded: 0, total: 0 },
        lastRefreshOk: null,
        lastRefreshAt: null,
      })),
    };
  });
  const a = createAgentLabeller("warnings.example:8443", {});
  createAgentLabeller("warnings.example:8443", {});
  const event = {
    kind: "directory" as const,
    ok: false,
    at: 1800000000,
    reason: "directory_timeout",
  };
  callbacks[0]!(event);
  callbacks[1]!(event);
  expect(warn).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(599999);
  callbacks[0]!(event);
  expect(warn).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  callbacks[0]!(event);
  expect(warn).toHaveBeenCalledTimes(2);
  callbacks[0]!({ ...event, kind: "ip" });
  callbacks[0]!({ ...event, ok: true });
  expect(warn).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(600000);
  callbacks[0]!({ ...event, kind: "ip" });
  expect(warn).toHaveBeenCalledTimes(3);
  callbacks[0]!({ ...event, kind: "sail" });
  expect(warn).toHaveBeenCalledTimes(3);
  vi.advanceTimersByTime(600000);
  callbacks[0]!({ ...event, kind: "sail" });
  expect(warn).toHaveBeenCalledTimes(4);
  expect(warn.mock.calls[0]).toEqual([
    "Agent verification refresh failed for warnings.example:8443: directory_timeout",
  ]);
  a.close();
});
