import { afterEach, expect, it, vi } from "vitest";
import {
  buildEventCollectUrl,
  collectRequest,
  sendGoogle,
  sendDeniedPing,
} from "../src/server/google.js";
import { createAgentCounters } from "../src/server/agent-counters.js";
import { createLabelMemory } from "../src/server/labels.js";
import { normalizeConsent } from "../src/shared/consent.js";
import type { TrackingEvent } from "../src/shared/event.js";

const destination = { measurementId: "G-TEST" };
const consent = normalizeConsent({ analytics_storage: "granted" });
function event(params: Record<string, unknown>): TrackingEvent {
  const now = Date.now();
  return {
    event_id: crypto.randomUUID(),
    name: "page_view",
    client_id: "1.2",
    session_id: 1,
    session_started_ms: now,
    session_expires_ms: now + 1800000,
    timestamp_ms: now,
    consent,
    params: { ...params, traffic_class: "automated", traffic_phase: "final" },
  };
}
function largeParams(length: number) {
  return Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => [
      `custom${i}`,
      "😀".repeat(Math.max(0, Math.min(100, length - i * 100))),
    ]),
  );
}
afterEach(() => vi.restoreAllMocks());
for (const kind of ["events", "pings"] as const) {
  it(`does not count or retain sticky evidence for oversized ${kind}`, async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const memory = createLabelMemory();
    const { counters, observe } = createAgentCounters();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const e = event(largeParams(2000));
    const send = (e: TrackingEvent) =>
      kind === "events"
        ? sendGoogle(
            destination,
            e,
            () => consent,
            new AbortController().signal,
            fetcher,
            undefined,
            undefined,
            memory,
            observe(kind, []),
          )
        : sendDeniedPing(
            destination,
            { ...e, consent: normalizeConsent({}), page_id: "1", hit_index: 1 },
            undefined,
            fetcher,
            undefined,
            undefined,
            memory,
            observe(kind, []),
          );
    expect(await send(e)).toBe("dropped");
    expect(fetcher).not.toHaveBeenCalled();
    expect(memory.size).toBe(0);
    expect(counters[kind].total).toBe(0);
    await send({ ...e, params: { traffic_class: "human", traffic_phase: "final" } });
    expect(counters[kind].byType.human).toBe(1);
  });
  it(`counts only the labels still present after the 16 KiB trim for ${kind}`, async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Find the boundary from the encoded wire size rather than depending on detail text length.
    let stripped: TrackingEvent | undefined;
    let detailOnly: TrackingEvent | undefined;
    for (let n = 1300; n < 1400; n++) {
      const e = event(largeParams(n));
      const request = collectRequest(buildEventCollectUrl(destination, e, consent)!);
      if (!request) continue;
      const fields = new URLSearchParams(request.body ?? request.url.search);
      if (!fields.has("ep.vv_type")) stripped ??= e;
      else if (!fields.has("ep.vv_detail")) detailOnly ??= e;
    }
    expect(stripped).toBeDefined();
    expect(detailOnly).toBeDefined();
    for (const [e, expected] of [
      [stripped!, 0],
      [detailOnly!, 1],
    ] as const) {
      const memory = createLabelMemory();
      const { counters, observe } = createAgentCounters();
      const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
      const result =
        kind === "events"
          ? await sendGoogle(
              destination,
              e,
              () => consent,
              new AbortController().signal,
              fetcher,
              undefined,
              undefined,
              memory,
              observe(kind, []),
            )
          : await sendDeniedPing(
              destination,
              { ...e, consent: normalizeConsent({}), page_id: "1", hit_index: 1 },
              undefined,
              fetcher,
              undefined,
              undefined,
              memory,
              observe(kind, []),
            );
      expect(result).toBe("sent");
      const [url, init] = fetcher.mock.calls[0]!;
      const fields = new URLSearchParams((init?.body as string) ?? new URL(String(url)).search);
      expect(fields.has("ep.vv_type")).toBe(Boolean(expected));
      expect(fields.has("ep.vv_detail")).toBe(false);
      expect(counters[kind].total).toBe(expected);
      expect(counters[kind].byType.bot_automation).toBe(expected);
      expect(memory.size).toBe(expected);
    }
  });
}
it("does not count or retain labels when aborted while awaiting verification", async () => {
  const memory = createLabelMemory();
  const { counters, observe } = createAgentCounters();
  const controller = new AbortController();
  let finish!: () => void;
  const verification = new Promise<undefined>((resolve) => {
    finish = () => resolve(undefined);
  });
  const fetcher = vi.fn<typeof fetch>();
  const delivery = sendGoogle(
    destination,
    event({}),
    () => consent,
    controller.signal,
    fetcher,
    undefined,
    verification,
    memory,
    observe("events", []),
  );
  controller.abort();
  finish();
  expect(await delivery).toBe("dropped");
  expect(fetcher).not.toHaveBeenCalled();
  expect(memory.size).toBe(0);
  expect(counters.events.total).toBe(0);
});
