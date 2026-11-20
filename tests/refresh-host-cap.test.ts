import { afterEach, expect, it, vi } from "vitest";
import * as library from "visitor-verdict-server";
import { createAgentLabeller } from "../src/server/agent-verification.js";

vi.mock("visitor-verdict-server", async (importOriginal) => {
  const actual = await importOriginal<typeof library>();
  return { ...actual, createVerifier: vi.fn(actual.createVerifier) };
});
const actual = await vi.importActual<typeof library>("visitor-verdict-server");
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(library.createVerifier).mockImplementation(actual.createVerifier);
  vi.useRealTimers();
});

it("refresh warnings track at most 128 hosts; a 129th new host is not logged", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1900000000000); // far from other tests' clocks, so earlier entries are stale
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  const callbacks: NonNullable<library.VerifierOptions["onRefresh"]>[] = [];
  vi.mocked(library.createVerifier).mockImplementation((options) => {
    callbacks.push(options.onRefresh!);
    return {
      verify: vi.fn(),
      warm: vi.fn(async () => ({ ok: [], failed: [] })),
      close: vi.fn(),
      status: vi.fn(),
    } as unknown as ReturnType<typeof library.createVerifier>;
  });
  for (let i = 0; i < 129; i++) createAgentLabeller(`h${i}.cap.example`, {});
  const event = {
    kind: "directory" as const,
    ok: false,
    at: 1900000000,
    reason: "directory_timeout",
  };
  for (const [i, callback] of callbacks.entries())
    callback({ ...event, hostname: `h${i}.cap.example` });
  expect(warn).toHaveBeenCalledTimes(128);
  expect(warn).not.toHaveBeenCalledWith(
    "Agent verification refresh failed for h128.cap.example: directory_timeout",
  );
});
