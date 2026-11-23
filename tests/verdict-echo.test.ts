import { expect, it, vi } from "vitest";
import { createVerdictEcho } from "../src/client/server-verdict.js";
import { normalizeEventItem } from "../src/client/data-layer.js";
import { serverVerdict, verdictOperators } from "../src/shared/verdict.js";
import { defaultRegistry } from "visitor-verdict-server";
import { page } from "./browser-fixture.js";
const vv = {
  v: 1,
  ttl: 1800,
  type: "agent_verified",
  operator: "openai",
  verification: "signature_valid",
  purpose: "user_directed",
};
const response = (value: unknown = { vv }) => Response.json(value);
function host() {
  const values = new Map<string, string>();
  return {
    dataLayer: [] as unknown[],
    sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
    values,
  };
}
it("keeps wire operators equal to the library registry", () => {
  expect(verdictOperators).toEqual(defaultRegistry.map((x) => x.operator));
});
it("publishes once, preserving detector and its version, without a forwarding loop", async () => {
  const h = {
    ...host(),
    __visitorVerdict: Object.freeze({ class: "automated", version: "1.4.0" }),
  };
  const snapshot = h.__visitorVerdict;
  const receive = createVerdictEcho(h);
  await receive(response());
  await receive(response());
  expect(h.__visitorVerdict).toBe(snapshot);
  expect(h.dataLayer).toEqual([
    {
      event: "traffic_class",
      traffic_class: "declared_agent",
      traffic_phase: "agent",
      traffic_agent: "openai",
      traffic_agent_claim: "server_signature",
      traffic_version: "1.4.0",
      traffic_score: undefined,
      traffic_signals: undefined,
      traffic_source: "vanilla",
    },
  ]);
  expect(normalizeEventItem(h.dataLayer[0])).toBeUndefined();
  expect(Object.isFrozen((h as unknown as Record<string, unknown>).__visitorVerdictServer)).toBe(
    true,
  );
});
it("never publishes crawlers to the configured layer", async () => {
  const h = { ...host(), visitorVerdictConfig: { dataLayerName: "custom" }, custom: [] };
  await createVerdictEcho(h)(
    response({
      vv: { ...vv, type: "crawler_verified", purpose: "crawler", verification: "ip_match" },
    }),
  );
  expect(h.dataLayer).toEqual([]);
  expect(h.custom).toEqual([]);
});
it("suppresses the same browser identity but still saves memory", async () => {
  const h = {
    ...host(),
    __visitorVerdict: Object.freeze({
      class: "declared_agent",
      agent: "openai",
      claim: "server_signature",
    }),
  };
  const receive = createVerdictEcho(h);
  receive.consent(true);
  await receive(response(), true);
  expect(h.dataLayer).toEqual([]);
  expect(h.values.size).toBe(1);
});
it("restores immediately with a 30 minute TTL and overwrites operators without clearing on 204", async () => {
  let now = 1000;
  const h = host();
  const receive = createVerdictEcho(h, () => now);
  receive.consent(true);
  await receive(response(), true);
  await receive(new Response(null, { status: 204 }), true);
  const next = { ...h, dataLayer: [] };
  createVerdictEcho(next, () => now + 1799999);
  expect(next.dataLayer).toHaveLength(1);
  const expired = { ...h, dataLayer: [] };
  createVerdictEcho(expired, () => now + 1800000);
  expect(expired.dataLayer).toHaveLength(0);
  await receive(response({ vv: { ...vv, operator: "anthropic" } }), true);
  expect([...h.values.values()][0]).toContain("anthropic");
  expect(h.dataLayer).toHaveLength(2);
});
it("ignores invalid status, content type, schema, JSON and oversized streams", async () => {
  const h = host();
  const receive = createVerdictEcho(h);
  for (const r of [
    new Response(null, { status: 204 }),
    new Response(JSON.stringify({ vv })),
    response({ vv: { ...vv, v: 2 } }),
    response({ vv: { ...vv, operator: "evil" } }),
    response({ vv: { ...vv, type: "human" } }),
    new Response("{", { headers: { "content-type": "application/json" } }),
    response({ vv, padding: "x".repeat(1024) }),
  ])
    await receive(r);
  expect(h.dataLayer).toEqual([]);
  expect(h.values.size).toBe(0);
  expect(serverVerdict({ ...vv, operator: "x".repeat(25) })).toBeUndefined();
});
it("storage failures do not prevent publication", async () => {
  const h = host();
  h.sessionStorage.getItem = () => {
    throw Error();
  };
  h.sessionStorage.setItem = () => {
    throw Error();
  };
  await createVerdictEcho(h)(response());
  expect(h.dataLayer).toHaveLength(1);
});
it("browser integration consumes a response without collecting its own publication", async () => {
  const p = page([], {
    dataset: { pings: "off", verdictEcho: "on" },
    context: { TextDecoder, setTimeout, clearTimeout },
    setup(h) {
      (h.fetch as ReturnType<typeof vi.fn>).mockImplementation(async () => response());
    },
  });
  p.command("consent", "update", { analytics_storage: "granted" });
  // Stream decoding crosses asynchronous turns.
  await vi.waitFor(() =>
    expect(
      p.host.dataLayer.filter((x) => (x as Record<string, unknown>).traffic_source === "vanilla")
        .length,
    ).toBe(1),
  );
  expect(p.fetcher).toHaveBeenCalledTimes(1);
});

it("custom layer browser publication cannot send another hit", async () => {
  const p = page([], {
    dataset: { pings: "off", verdictEcho: "on" },
    context: { TextDecoder, setTimeout, clearTimeout },
    setup(h) {
      h.visitorVerdictConfig = { dataLayerName: "verdictLayer" };
      h.verdictLayer = [];
      (h.fetch as ReturnType<typeof vi.fn>).mockImplementation(async () => response());
    },
  });
  p.command("consent", "update", { analytics_storage: "granted" });
  await vi.waitFor(() =>
    expect((p.host as unknown as { verdictLayer: unknown[] }).verdictLayer.length).toBe(1),
  );
  expect(p.fetcher).toHaveBeenCalledTimes(1);
});
it("disabled echo neither consumes responses nor publishes", async () => {
  const p = page([], {
    dataset: { pings: "off", verdictEcho: "off" },
    context: { TextDecoder, setTimeout, clearTimeout },
    setup(h) {
      (h.fetch as ReturnType<typeof vi.fn>).mockImplementation(async () => response());
    },
  });
  p.command("consent", "update", { analytics_storage: "granted" });
  for (let i = 0; i < 40; i++) await Promise.resolve();
  expect(p.host.dataLayer.length).toBe(1);
  expect("__visitorVerdictServer" in p.host).toBe(false);
});
it("rejects future and corrupt stored values", async () => {
  const h = host();
  h.values.set("vanilla.verdict.v1", JSON.stringify({ at: 2000, vv }));
  createVerdictEcho(h, () => 1000);
  h.values.set("vanilla.verdict.v1", "{");
  createVerdictEcho(h, () => 1000);
  expect(h.dataLayer).toEqual([]);
});
it("ignores a stream that never finishes without delaying event delivery", async () => {
  vi.useFakeTimers();
  try {
    const h = host();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ vv })));
      },
    });
    const pending = createVerdictEcho(h)(
      new Response(body, { headers: { "content-type": "application/json" } }),
    );
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    expect(h.dataLayer).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

for (const claim of ["dom_marker", "dom_host"])
  it(`upgrades ${claim} to server_signature once`, async () => {
    const h = {
      ...host(),
      __visitorVerdict: Object.freeze({ class: "declared_agent", agent: "openai", claim }),
    };
    const consume = createVerdictEcho(h);
    await consume(response());
    await consume(response());
    expect(h.dataLayer).toHaveLength(1);
    expect(h.dataLayer[0]).toMatchObject({ traffic_agent_claim: "server_signature" });
    expect(h.__visitorVerdict.claim).toBe(claim);
  });
for (const operator of ["browserbase", "kernel", "cloudflare_browser_run", "shopify_cloudsurf"])
  it(`identifies ${operator} as intermediary infrastructure`, async () => {
    const h = host();
    await createVerdictEcho(h)(response({ vv: { ...vv, operator, purpose: "intermediary" } }));
    expect(h.dataLayer).toMatchObject([
      { traffic_agent: operator, traffic_agent_claim: "server_intermediary" },
    ]);
  });
it("uses script layer before config, accepting array-like layers and resetting model fields", async () => {
  const model: Record<string, unknown> = { traffic_score: 100, traffic_signals: ["WD"] };
  const h = {
    ...host(),
    visitorVerdictConfig: { dataLayerName: "wrong" },
    custom: { length: 0, push: vi.fn((item) => Object.assign(model, item)) },
  };
  await createVerdictEcho(h, Date.now, "custom")(response());
  expect(h.custom.push).toHaveBeenCalledTimes(1);
  expect(h.dataLayer).toEqual([]);
  expect(model.traffic_score).toBeUndefined();
  expect(model.traffic_signals).toBeUndefined();
  expect(h.custom.push.mock.calls[0]![0]).toHaveProperty("traffic_score", undefined);
  expect(h.custom.push.mock.calls[0]![0]).toHaveProperty("traffic_signals", undefined);
});
it("expires short proof memory at its ttl and corrects a restored operator", async () => {
  let clock = 1000;
  const h = host();
  const consume = createVerdictEcho(h, () => clock);
  consume.consent(true);
  await consume(response({ vv: { ...vv, ttl: 5 } }), true);
  const next = { ...h, dataLayer: [] };
  clock += 4999;
  const nextConsumer = createVerdictEcho(next, () => clock);
  expect(next.dataLayer).toHaveLength(1);
  nextConsumer.consent(true);
  await nextConsumer(response({ vv: { ...vv, operator: "anthropic" } }), true);
  await nextConsumer(response({ vv: { ...vv, operator: "anthropic" } }), true);
  expect(next.dataLayer).toHaveLength(2);
  const expired = { ...h, dataLayer: [] };
  // Restore the original short proof record rather than the replacement.
  h.values.set("vanilla.verdict.v1", JSON.stringify({ at: 1000, vv: { ...vv, ttl: 5 } }));
  clock = 6000;
  createVerdictEcho(expired, () => clock);
  expect(expired.dataLayer).toHaveLength(0);
});
it("enforces ttl schema and reads the actual stream regardless of Content-Length", async () => {
  for (const ttl of [undefined, -1, 1801, 0.5, "60", Infinity])
    expect(serverVerdict({ ...vv, ttl })).toBeUndefined();
  const h = host();
  const consume = createVerdictEcho(h);
  await consume(
    new Response(JSON.stringify({ vv, padding: "x".repeat(1100) }), {
      headers: { "content-type": "application/json", "content-length": "1" },
    }),
  );
  expect(h.dataLayer).toHaveLength(0);
  await consume(
    new Response(JSON.stringify({ vv }), {
      headers: { "content-type": "application/json", "content-length": "5000" },
    }),
  );
  expect(h.dataLayer).toHaveLength(1);
});

const browserContext = { TextDecoder, setTimeout, clearTimeout };
const stored = () => {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
    } as unknown as Storage,
  };
};
it("browser persists after grant, restores to script layer, and clears on withdrawal", async () => {
  const { values, storage } = stored();
  const p = page([], {
    dataset: { verdictEcho: "on", pings: "off" },
    sessionStorage: storage,
    context: browserContext,
    setup(h) {
      (h.fetch as ReturnType<typeof vi.fn>).mockImplementation(async () => response());
    },
  });
  expect(storage.setItem).not.toHaveBeenCalled();
  p.command("consent", "update", { analytics_storage: "granted" });
  await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalledTimes(1));
  expect(JSON.parse(values.get("vanilla.verdict.v1")!)).toMatchObject({
    vv,
    at: expect.any(Number),
  });
  const next = page([], {
    dataset: { verdictEcho: "on", pings: "off", vvLayer: "early" },
    sessionStorage: storage,
    context: browserContext,
    setup(h) {
      h.visitorVerdictConfig = { dataLayerName: "wrong" };
    },
  });
  expect((next.host as unknown as { early: unknown[] }).early).toHaveLength(1);
  expect(next.host.dataLayer).toHaveLength(0);
  expect(next.fetcher).not.toHaveBeenCalled();
  p.command("consent", "update", { analytics_storage: "denied" });
  expect(storage.removeItem).toHaveBeenCalledWith("vanilla.verdict.v1");
  expect(values.has("vanilla.verdict.v1")).toBe(false);
});
it("a denied ping cannot persist even when consent is granted before its response", async () => {
  const { storage } = stored();
  let finish!: (value: Response) => void;
  const p = page([], {
    dataset: { verdictEcho: "on" },
    sessionStorage: storage,
    context: browserContext,
    setup(h) {
      (h.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) =>
        url.endsWith("/d")
          ? new Promise<Response>((r) => {
              finish = r;
            })
          : new Response(null, { status: 204 }),
      );
    },
  });
  p.command("consent", "update", { analytics_storage: "denied" });
  p.command("consent", "update", { analytics_storage: "granted" });
  finish(response());
  await vi.waitFor(() =>
    expect(
      p.host.dataLayer.filter((x) => (x as Record<string, unknown>).traffic_source === "vanilla"),
    ).toHaveLength(1),
  );
  expect(storage.setItem).not.toHaveBeenCalled();
});
it("an event body still decoding at withdrawal cannot restore deleted memory", async () => {
  const h = host();
  const consume = createVerdictEcho(h);
  consume.consent(true);
  let finish!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(JSON.stringify({ vv })));
      finish = () => c.close();
    },
  });
  const pending = consume(
    new Response(body, { headers: { "content-type": "application/json" } }),
    true,
  );
  consume.consent(false, true);
  consume.consent(true);
  finish();
  await pending;
  expect(h.values.size).toBe(0);
  expect(h.dataLayer).toHaveLength(0);
});
it("a raw tracker without the collector enable flag never reads stored memory", async () => {
  const { storage } = stored();
  const p = page([], {
    sessionStorage: storage,
    dataset: { pings: "off" },
    context: browserContext,
    setup(h) {
      (h.fetch as ReturnType<typeof vi.fn>).mockImplementation(async () => response());
    },
  });
  p.command("consent", "update", { analytics_storage: "granted" });
  for (let i = 0; i < 40; i++) await Promise.resolve();
  expect(storage.getItem).not.toHaveBeenCalled();
  expect(storage.setItem).not.toHaveBeenCalled();
  expect(p.host.dataLayer).toHaveLength(1);
});

it("upgrades IP proof to signature once without downgrading the same operator", async () => {
  const h = host();
  const consume = createVerdictEcho(h);
  await consume(response({ vv: { ...vv, verification: "ip_match" } }));
  await consume(response());
  await consume(response({ vv: { ...vv, verification: "ip_match" } }));
  expect(h.dataLayer).toHaveLength(2);
  expect(h.dataLayer[1]).toMatchObject({ traffic_agent_claim: "server_signature" });
});
it("an event response arriving after revoke and regrant cannot persist or publish", async () => {
  const { storage } = stored();
  let finish!: (r: Response) => void;
  let events = 0;
  const p = page([], {
    dataset: { verdictEcho: "on", pings: "off" },
    sessionStorage: storage,
    context: browserContext,
    setup(h) {
      (h.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
        if (url.endsWith("/e") && ++events === 1)
          return new Promise<Response>((r) => {
            finish = r;
          });
        return new Response(null, { status: 204 });
      });
    },
  });
  p.command("consent", "update", { analytics_storage: "granted" });
  p.command("consent", "update", { analytics_storage: "denied" });
  p.command("consent", "update", { analytics_storage: "granted" });
  finish(response());
  for (let i = 0; i < 80; i++) await Promise.resolve();
  expect(storage.setItem).not.toHaveBeenCalled();
  expect(
    p.host.dataLayer.filter((x) => (x as Record<string, unknown>).traffic_source === "vanilla"),
  ).toHaveLength(0);
});
