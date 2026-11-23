import { afterEach, expect, it, vi } from "vitest";
import { visitorLabels, defaultRegistry } from "visitor-verdict-server";
import { createLabelMemory } from "../src/server/labels.js";
import { createApp } from "../src/server/app.js";

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

for (const count of [10000, 100000])
  it(`${count} distinct sessions: capacity, eviction, heap and TTL sweep`, () => {
    let now = 0;
    const capacity = 10000;
    const memory = createLabelMemory(capacity, 1000, () => now);
    const strong = visitorLabels({ browserClass: "automated" });
    const weak = visitorLabels({ browserClass: "human" });
    const heapBefore = process.memoryUsage().heapUsed;
    const start = performance.now();
    let peak = 0;
    for (let i = 0; i < count; i++) {
      memory.apply(`session-${i}`, strong);
      peak = Math.max(peak, memory.size);
      if (i % 1000 === 0) expect(memory.size).toBeLessThanOrEqual(capacity);
    }
    const insertMs = performance.now() - start;
    const heapAfter = process.memoryUsage().heapUsed;
    expect(memory.size).toBe(capacity);
    expect(memory.apply(`session-${count - 1}`, weak, false).vv_type).toBe("bot_automation");
    if (count > capacity) expect(memory.apply("session-0", weak, false).vv_type).toBe("human");
    now = 500;
    memory.apply(`session-${count - 1}`, weak); // inheriting traffic cannot renew evidence
    now = 1000;
    const sweepStart = performance.now();
    memory.sweep();
    const sweepMs = performance.now() - sweepStart;
    expect(memory.size).toBe(0);
    now = 1500;
    memory.sweep();
    expect(memory.size).toBe(0);
    // Entry bound is exact; heap delta is observational because runner allocations and GC vary.
    expect(peak).toBe(capacity);
    console.log(
      JSON.stringify({
        scenario: "label-memory",
        count,
        capacity,
        peak,
        insertMs,
        sweepMs,
        heapDeltaBytes: heapAfter - heapBefore,
      }),
    );
  });

const config = {
  cookieSecret: "s".repeat(64),
  measurementId: "G-TEST",
  siteOrigin: "https://shop.example",
  trackerHost: "tracker.example",
  agentVerification: true,
};
const directories = defaultRegistry.filter((o) => o.directoryUrl).length;
const hosts = new Set(
  defaultRegistry.filter((o) => o.directoryUrl).map((o) => new URL(o.directoryUrl!).hostname),
);
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

it("all directories down: startup, 200 collector hits, retry warning limit and health accounting", async () => {
  // Date only is mocked; real promise scheduling and verifier timers remain in use.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(2200000000000);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  const rejected: unknown[] = [];
  const onReject = (error: unknown) => rejected.push(error);
  process.on("unhandledRejection", onReject);
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return new Response("down", { status: 503 });
  };
  const google = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const options = { fetcher, now: () => Date.now() / 1000 };
  const make = () => {
    const app = createApp(config, google, options);
    apps.push(app);
    return app;
  };
  try {
    const app = make();
    await app.ready();
    await turn();
    expect(calls).toBe(directories);
    const before = (await app.inject("/health")).json().agentVerification;
    expect(before.directoriesLoaded).toBe(`0/${directories}`);
    expect(before.lastRefreshOk).toBe(false);
    expect(warn).toHaveBeenCalledTimes(hosts.size);
    const start = performance.now();
    for (let i = 0; i < 200; i++) {
      const route = i % 2 === 0 ? "/e" : "/d";
      const now = Date.now();
      const response = await app.inject({
        method: "POST",
        url: route,
        remoteAddress: "192.0.2.1",
        headers: {
          origin: config.siteOrigin,
          "content-type": "application/json",
          "user-agent": "Mozilla/5.0",
          "signature-input": "s=(",
          signature: "s=:!:",
        },
        payload: {
          name: "page_view",
          client_id: `123.${i + 1}`,
          session_id: i + 1,
          page_id: String(i),
          hit_index: 1,
          event_id: crypto.randomUUID(),
          session_started_ms: now,
          session_expires_ms: now + 1800000,
          timestamp_ms: now,
          params: { page_location: config.siteOrigin },
          consent: { analytics_storage: route === "/d" ? "denied" : "granted" },
        },
      });
      expect(response.statusCode, response.body).toBe(204);
    }
    const elapsedMs = performance.now() - start;
    const health = (await app.inject("/health")).json();
    expect(google).toHaveBeenCalledTimes(200);
    for (const kind of ["events", "pings"]) {
      const counts = health.agentVerification.counters[kind];
      expect(counts.total).toBe(100);
      expect(Object.values(counts.byType).reduce((a, b) => Number(a) + Number(b), 0)).toBe(100);
      expect(Object.values(counts.byVerification).reduce((a, b) => Number(a) + Number(b), 0)).toBe(
        100,
      );
      expect(counts.byVerification.signature_invalid).toBe(0);
      expect(counts.byVerification.none).toBe(100);
      expect(counts.evidence.signatureHeaders).toBe(100);
    }
    expect(health.google.errors).toBe(0);
    expect(calls).toBe(directories);
    await app.close();
    // Fresh verifier instances cause real failures again; the process-wide warning limit persists.
    vi.setSystemTime(2200000599999);
    const second = make();
    await second.ready();
    await turn();
    await second.close();
    expect(warn).toHaveBeenCalledTimes(hosts.size);
    vi.setSystemTime(2200000600000);
    const third = make();
    await third.ready();
    await turn();
    await third.close();
    expect(warn).toHaveBeenCalledTimes(hosts.size * 2);
    expect(rejected).toEqual([]);
    console.log(
      JSON.stringify({
        scenario: "startup-outage",
        directories,
        hosts: hosts.size,
        hits: 200,
        elapsedMs,
        fetches: calls,
        warnings: warn.mock.calls.length,
        counters: health.agentVerification.counters,
        google: health.google,
      }),
    );
  } finally {
    process.off("unhandledRejection", onReject);
  }
});

it("stalled startup directories keep cache-only signed requests responsive", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(2300000000000);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { createAgentLabeller } = await import("../src/server/agent-verification.js");
  let fetches = 0;
  const labeller = createAgentLabeller("tracker.example", {
    fetcher: () => {
      fetches++;
      return new Promise<Response>(() => {});
    },
  });
  const input =
    '("@authority" "signature-agent");created=2300000000;expires=2300000060;keyid="missing";tag="web-bot-auth"';
  const request = {
    method: "GET",
    url: "/",
    ip: "192.0.2.1",
    raw: {
      rawHeaders: [
        "signature-agent",
        '"https://chatgpt.com"',
        "signature-input",
        "s=" + input,
        "signature",
        "s=:" + Buffer.alloc(64).toString("base64") + ":",
      ],
    },
  } as import("fastify").FastifyRequest;
  try {
    const start = performance.now();
    const results = await Promise.all(Array.from({ length: 1000 }, () => labeller.label(request)));
    const elapsedMs = performance.now() - start;
    expect([...new Set(results.map((result) => result?.reason))]).toEqual(["cache_miss"]);
    expect(elapsedMs).toBeLessThan(1500);
    expect(fetches).toBe(directories);
    expect(labeller.status().directoriesLoaded).toBe(`0/${directories}`);
    console.log(JSON.stringify({ scenario: "stalled-startup", count: 1000, elapsedMs, fetches }));
  } finally {
    labeller.close();
  }
});

it("1000 concurrent signed requests through Vanilla's real labeller use the warm cache", async () => {
  const { generateKeyPairSync, createHash, sign } = await import("node:crypto");
  const { createAgentLabeller } = await import("../src/server/agent-verification.js");
  vi.spyOn(console, "info").mockImplementation(() => {});
  const pair = generateKeyPairSync("ed25519");
  const jwk = pair.publicKey.export({ format: "jwk" });
  const kid = createHash("sha256")
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
    .digest("base64url");
  const clock = 2400000000;
  let fetches = 0;
  const labeller = createAgentLabeller("tracker.example", {
    now: () => clock,
    fetcher: async () => {
      fetches++;
      return Response.json({ keys: [jwk] });
    },
  });
  try {
    await turn();
    expect(labeller.status().directoriesLoaded).toBe(`${directories}/${directories}`);
    const params = `("@authority" "@method" "signature-agent");created=${clock};expires=${clock + 60};keyid="${kid}";tag="web-bot-auth";nonce="load-test"`;
    const base = `"@authority": tracker.example\n"@method": GET\n"signature-agent": "https://chatgpt.com"\n"@signature-params": ${params}`;
    const signature = sign(null, Buffer.from(base), pair.privateKey).toString("base64");
    const request = {
      method: "GET",
      url: "/",
      ip: "192.0.2.1",
      raw: {
        rawHeaders: [
          "signature-agent",
          '"https://chatgpt.com"',
          "signature-input",
          "s=" + params,
          "signature",
          "s=:" + signature + ":",
        ],
      },
    } as import("fastify").FastifyRequest;
    const samples: number[] = [];
    const started = performance.now();
    let timerDelayMs = 0;
    const timer = new Promise<void>((resolve) =>
      setTimeout(() => {
        timerDelayMs = performance.now() - started;
        resolve();
      }, 0),
    );
    const results = await Promise.all(
      Array.from({ length: 1000 }, async () => {
        const start = performance.now();
        const result = await labeller.label(request);
        samples.push(performance.now() - start);
        return result;
      }),
    );
    await timer;
    samples.sort((a, b) => a - b);
    expect(results.filter((result) => result?.verification === "signature_valid")).toHaveLength(1);
    expect(results.filter((result) => result?.reason === "replay")).toHaveLength(999);
    expect(fetches).toBe(directories);
    expect(samples.at(-1)).toBeLessThan(1500);
    console.log(
      JSON.stringify({
        scenario: "vanilla-signed-load",
        count: 1000,
        fetches,
        latencyMs: {
          p50: samples[500],
          p95: samples[950],
          p99: samples[990],
          max: samples.at(-1),
        },
        timerDelayMs,
      }),
    );
  } finally {
    labeller.close();
  }
});
