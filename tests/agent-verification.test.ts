import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import * as verdict from "visitor-verdict-server";
import { createApp } from "../src/server/app.js";
import { collectRequest } from "../src/server/google.js";
import { configFromEnv } from "../src/server/config.js";

vi.mock("visitor-verdict-server", async (importOriginal) => {
  const actual = await importOriginal<typeof verdict>();
  return { ...actual, createVerifier: vi.fn(actual.createVerifier) };
});

const actual = await vi.importActual<typeof verdict>("visitor-verdict-server");
function detail(hit: URLSearchParams, index: number) {
  const part = hit.get("ep.vv_detail")?.split("|")[index];
  return part === "-" ? null : (part ?? null);
}
const chatgpt = "https://chatgpt.com/.well-known/http-message-signatures-directory";
/** Wrap the real verifier so a test can see and await the startup warm-up. */
function spyOnWarm() {
  const warm = vi.fn<verdict.AgentVerifier["warm"]>();
  vi.mocked(verdict.createVerifier).mockImplementation((options) => {
    const verifier = actual.createVerifier(options);
    warm.mockImplementation((value) => verifier.warm(value));
    return { verify: verifier.verify, warm, close: verifier.close, status: verifier.status };
  });
  return warm;
}
const fakeVerifier = (verify: verdict.AgentVerifier["verify"]): verdict.AgentVerifier => ({
  verify,
  warm: vi.fn(async () => ({ ok: [], failed: [] })),
  close: vi.fn(),
  status: vi.fn(() => ({
    directories: { loaded: 0, total: 5 },
    ipLists: { loaded: 0, total: 0 },
    lastRefreshOk: null,
    lastRefreshAt: null,
  })),
});

const capture = JSON.parse(
  readFileSync(new URL("./fixtures/chatgpt-agent-2026-11-20.json", import.meta.url), "utf8"),
) as { requests: { method: string; path: string; ts: string; headers: Record<string, string> }[] };
const directory = readFileSync(
  new URL("./fixtures/openai-directory-2026-11-20.json", import.meta.url),
  "utf8",
);
const signed = capture.requests.filter((request) => request.method === "POST");
const config = {
  cookieSecret: "s".repeat(64),
  measurementId: "G-TEST",
  siteOrigin: "https://shop.example",
  trackerHost: signed[0]!.headers.host,
  agentVerification: true,
};
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
  vi.mocked(verdict.createVerifier).mockImplementation(actual.createVerifier);
  vi.clearAllMocks();
  vi.useRealTimers();
});
function setup(
  enabled = true,
  options: Parameters<typeof createApp>[2] = {},
  privacy: {
    verdictEcho?: boolean;
    deniedPingIp?: "full" | "truncated" | "off";
    deniedPingUserAgent?: boolean;
  } = {},
) {
  const google = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const app = createApp(
    { ...config, verdictEcho: false, agentVerification: enabled, ...privacy },
    google,
    options,
  );
  apps.push(app);
  const post = (path: string, headers: Record<string, string> = {}, params: object = {}) => {
    const now = Date.now();
    const common = {
      name: "page_view",
      client_id: "123.456",
      session_id: 123,
      page_id: "123",
      hit_index: 1,
      params: { page_location: config.siteOrigin, ...params },
    };
    return app.inject({
      method: "POST",
      url: path,
      headers: {
        ...headers,
        // Signature must use configured authority even behind a proxy with an internal Host.
        host: "internal.invalid",
        "x-forwarded-host": "untrusted.invalid",
        origin: config.siteOrigin,
        "content-type": "application/json",
        "user-agent": headers["user-agent"] ?? "Mozilla/5.0 Chrome/140.0",
      },
      payload: path.startsWith("/d")
        ? { ...common, consent: { analytics_storage: "denied" } }
        : {
            ...common,
            event_id: crypto.randomUUID(),
            session_started_ms: now,
            session_expires_ms: now + 1800000,
            timestamp_ms: now,
            consent: { analytics_storage: "granted" },
          },
    });
  };
  const hit = () => {
    const [url, init] = google.mock.calls.at(-1)!;
    return new URLSearchParams(new URL(String(url)).search + "&" + (init?.body ?? ""));
  };
  return { app, google, post, hit };
}

it("validates the optional flag and only requires the tracker host when enabled", () => {
  const env = { GA4_MEASUREMENT_ID: "G-TEST", COOKIE_SECRET: "s".repeat(64) };
  expect(configFromEnv(env).agentVerification).toBe(false);
  expect(() => configFromEnv({ ...env, AGENT_VERIFICATION: "yes" })).toThrow("on or off");
  expect(() => configFromEnv({ ...env, AGENT_VERIFICATION: "on" })).toThrow("TRACKER_DOMAIN");
  expect(() =>
    configFromEnv({ ...env, AGENT_VERIFICATION: "on", TRACKER_DOMAIN: "https://bad/" }),
  ).toThrow("TRACKER_DOMAIN");
  expect(
    configFromEnv({ ...env, AGENT_VERIFICATION: "on", TRACKER_DOMAIN: config.trackerHost })
      .agentVerification,
  ).toBe(true);
});

it("off constructs no verifier, makes no verification fetch and adds no labels on either route", async () => {
  const construct = vi.spyOn(verdict, "createVerifier");
  const warm = spyOnWarm();
  const fetcher = vi.fn();
  const { post, google, hit } = setup(false, { fetcher });
  for (const path of ["/e", "/d"]) {
    expect((await post(path, signed[0]!.headers)).statusCode).toBe(204);
    for (const name of ["agent_claim", "agent_operator", "agent_verification", "agent_purpose"])
      expect(hit().has(`ep.${name}`)).toBe(false);
  }
  expect(construct).not.toHaveBeenCalled();
  expect(warm).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
  expect(google).toHaveBeenCalledTimes(2);
});

it.each([
  {},
  { deniedPingIp: "truncated" as const, deniedPingUserAgent: false },
  { deniedPingIp: "off" as const, deniedPingUserAgent: false },
])(
  "verifies every captured POST signature on both delivery paths independently of ping privacy %j",
  async (privacy) => {
    const construct = vi.spyOn(verdict, "createVerifier");
    const warm = spyOnWarm();
    const fetcher = vi.fn(async (url: string) =>
      url === chatgpt
        ? new Response(directory, { headers: { "cache-control": "max-age=3600" } })
        : new Response(null, { status: 404 }),
    );
    let clock = Date.parse(signed[0]!.ts) / 1000;
    const { post, hit, google } = setup(true, { fetcher, now: () => clock }, privacy);
    const directories = verdict.defaultRegistry.filter((operator) => operator.directoryUrl).length;
    expect(await warm.mock.results[0]!.value).toMatchObject({ ok: [chatgpt] });
    for (const request of signed) {
      clock = Date.parse(request.ts) / 1000;
      for (const path of ["/e", "/d"]) {
        expect((await post(path, request.headers)).statusCode).toBe(204);
        expect(detail(hit(), 1)).toBe(path === "/e" ? "signature_valid" : "none");
        expect(detail(hit(), 0)).toBe(path === "/e" ? "openai" : "none");
        expect(hit().get("ep.vv_type")).toBe(path === "/e" ? "agent_verified" : "agent_unverified");
        if (path === "/e") {
          expect(detail(hit(), 2)).toBe("user_directed");
          expect(detail(hit(), 3)).toBe("signature_agent");
        }
        expect(String(google.mock.calls.at(-1))).not.toContain(request.headers.signature);
      }
    }
    expect(construct).toHaveBeenCalledTimes(1);
    expect(construct.mock.calls[0]![0].reverseDns).toEqual({ enabled: false });
    expect(construct.mock.calls[0]![0].poppy?.enabled ?? false).toBe(false);
    // Only the startup warm-up fetched: one request per registry directory, none per hit.
    expect(fetcher).toHaveBeenCalledTimes(directories);
    expect(fetcher.mock.calls.filter(([url]) => url === chatgpt)).toHaveLength(1);
  },
);

it("labels unsigned visitors without network access and preserves the parameter limit", async () => {
  const warm = spyOnWarm();
  const fetcher = vi.fn();
  const { post, hit } = setup(true, { fetcher });
  await warm.mock.results[0]!.value;
  fetcher.mockClear();
  const params = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`custom_${i}`, i]));
  for (const path of ["/e", "/d"]) {
    expect(
      (
        await post(
          path,
          {},
          {
            ...params,
            agent_verification: "signature_valid",
            agent_operator: "spoofed",
            agent_purpose: "crawler",
            agent_claim: "spoofed",
            google_reserved: "bad",
          },
        )
      ).statusCode,
    ).toBe(204);
    expect(detail(hit(), 1)).toBe("no_signature");
    expect(detail(hit(), 0)).toBe("none");
    expect(detail(hit(), 3)).toBe("none");
    expect(hit().has("ep.google_reserved")).toBe(false);
    expect([...hit().keys()].filter((key) => /^ep[n]?\./.test(key)).length).toBeLessThanOrEqual(25);
  }
  expect(fetcher).not.toHaveBeenCalled();
});

for (const failure of ["throw", "reject"] as const) {
  it(`sends both hits without labels after a verifier ${failure}`, async () => {
    const verify = vi.fn(() => {
      if (failure === "throw") throw new Error("failure");
      if (failure === "reject") return Promise.reject(new Error("failure"));
      return Promise.reject(new Error("failure"));
    });
    vi.spyOn(verdict, "createVerifier").mockReturnValue(fakeVerifier(verify));
    const { post, hit, google } = setup();
    for (const path of ["/e", "/d"]) {
      expect((await post(path, {}, { agent_operator: "spoofed" })).statusCode).toBe(204);
      expect(hit().has("ep.agent_operator")).toBe(false);
      expect(hit().has("ep.agent_verification")).toBe(false);
    }
    expect(google).toHaveBeenCalledTimes(2);
    expect(verify.mock.calls).toHaveLength(2);
  });
}

it("starts one background warm-up with refresh-ahead when on, without blocking startup", async () => {
  const warm = spyOnWarm();
  const fetcher = vi.fn(() => new Promise<Response>(() => {}));
  const { post, google } = setup(true, { fetcher });
  expect(warm).toHaveBeenCalledTimes(1);
  expect(warm).toHaveBeenCalledWith({ refreshAhead: true });
  expect((await post("/e")).statusCode).toBe(204);
  expect(google).toHaveBeenCalledTimes(1);
  expect(warm).toHaveBeenCalledTimes(1);
});

for (const failure of ["throw", "reject"] as const)
  it(`a warm-up ${failure} never breaks startup or hits`, async () => {
    const verifier = fakeVerifier(async () => ({
      agent_purpose: "unknown",
      claimed: { uaTokens: [], signatureAgents: [] },
      verification: "no_signature",
      reason: "signature_headers_absent",
      signatures: [],
    }));
    vi.mocked(verifier.warm).mockImplementation(() => {
      if (failure === "throw") throw new Error("failure");
      return Promise.reject(new Error("failure"));
    });
    vi.spyOn(verdict, "createVerifier").mockReturnValue(verifier);
    const { app, post, hit } = setup();
    expect((await post("/e")).statusCode).toBe(204);
    expect(detail(hit(), 1)).toBe("no_signature");
    await app.close();
    expect(verifier.close).toHaveBeenCalledTimes(1);
  });

it("app.close() stops the verifier's refresh timers and leaves no pending timers", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const warm = spyOnWarm();
  const fetcher = vi.fn(async (url: string) =>
    url === chatgpt
      ? new Response(directory, { headers: { "cache-control": "no-store" } })
      : new Response(null, { status: 404 }),
  );
  const { app } = setup(true, { fetcher, now: () => Date.parse(signed[0]!.ts) / 1000 });
  await warm.mock.results[0]!.value;
  // The app's sweep interval plus one refresh or retry timer per directory.
  expect(vi.getTimerCount()).toBeGreaterThan(1);
  await app.close();
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds a stalled directory fetch and sends without labels", async () => {
  const fetcher = vi.fn(() => new Promise<Response>(() => {}));
  const { post, hit, google } = setup(true, {
    fetcher,
    now: () => Date.parse(signed[0]!.ts) / 1000,
  });
  for (const path of ["/e", "/d"]) {
    expect((await post(path, signed[0]!.headers)).statusCode).toBe(204);
    expect(hit().has("ep.agent_verification")).toBe(false);
  }
  expect(google).toHaveBeenCalledTimes(2);
});

it("an offline operator adds no network wait before Google on /e or /d", async () => {
  const timings: Record<string, number[]> = {};
  for (const enabled of [false, true]) {
    const { app, post, google, hit } = setup(enabled, {
      fetcher: () => new Promise<Response>(() => {}),
      now: () => Date.parse(signed[0]!.ts) / 1000,
    });
    await app.ready();
    for (const route of ["/e", "/d"]) {
      // Prime route compilation and identity setup before comparing delivery latency.
      await post(route, signed[0]!.headers);
      const samples: number[] = [];
      let started = 0;
      google.mockImplementation(async () => {
        samples.push(performance.now() - started);
        return new Response(null, { status: 204 });
      });
      for (let i = 0; i < 7; i++) {
        started = performance.now();
        expect(
          (
            await post(route, signed[0]!.headers, {
              vv_type: "bot_spoofed",
              vv_detail: "spoofed",
              agent_verification: "signature_valid",
              agent_operator: "spoofed",
              agent_purpose: "crawler",
              agent_claim: "spoofed",
            })
          ).statusCode,
        ).toBe(204);
        for (const name of ["agent_verification", "agent_operator", "agent_purpose", "agent_claim"])
          expect(hit().has(`ep.${name}`)).toBe(false);
      }
      timings[`${enabled}:${route}`] = samples.sort((a, b) => a - b);
    }
  }
  for (const route of ["/e", "/d"]) {
    const off = timings[`false:${route}`]![3]!;
    const on = timings[`true:${route}`]![3]!;
    expect(on).toBeLessThan(off + 5);
  }
});

it("a cold hit omits labels and a later hit uses the completed startup warm-up", async () => {
  const warm = spyOnWarm();
  let release!: (response: Response) => void;
  const { post, hit } = setup(true, {
    fetcher: async (url) =>
      url === chatgpt
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : new Response(null, { status: 404 }),
    now: () => Date.parse(signed[0]!.ts) / 1000,
  });
  expect((await post("/e", signed[0]!.headers)).statusCode).toBe(204);
  expect(hit().has("ep.agent_verification")).toBe(false);
  release(new Response(directory, { headers: { "cache-control": "no-store" } }));
  await warm.mock.results[0]!.value;
  expect((await post("/e", signed[0]!.headers)).statusCode).toBe(204);
  expect(detail(hit(), 1)).toBe("signature_valid");
});

for (const enabled of [false, true])
  it(`always strips client-supplied reserved agent names with verification ${enabled}`, async () => {
    const { post, hit } = setup(enabled, {
      fetcher: async () => {
        throw Error("offline");
      },
    });
    for (const route of ["/e", "/d"]) {
      expect(
        (
          await post(
            route,
            {},
            {
              vv_type: "bot_spoofed",
              vv_detail: "spoofed",
              agent_verification: "signature_valid",
              agent_operator: "spoofed",
              agent_purpose: "crawler",
              agent_claim: "spoofed",
            },
          )
        ).statusCode,
      ).toBe(204);
      expect(detail(hit(), 1)).toBe(enabled ? "no_signature" : null);
      expect(hit().get("ep.vv_type")).toBe("pending");
      expect(hit().get("ep.vv_detail")).not.toContain("spoofed");
      expect(detail(hit(), 0)).toBe("none");
      expect(detail(hit(), 3)).toBe(enabled ? "none" : null);
      expect(detail(hit(), 2)).toBe(enabled ? "unknown" : null);
    }
  });

it("omits fields after a failed directory fetch without failing either hit", async () => {
  const fetcher = vi.fn(async () => {
    throw new Error("unavailable");
  });
  const { post, hit, google } = setup(true, {
    fetcher,
    now: () => Date.parse(signed[0]!.ts) / 1000,
  });
  for (const path of ["/e", "/d"]) {
    expect((await post(path, signed[0]!.headers)).statusCode).toBe(204);
    expect(hit().has("ep.agent_verification")).toBe(false);
  }
  expect(google).toHaveBeenCalledTimes(2);
});

it("passes raw headers, trusted client IP and the unchanged target to verification", async () => {
  const verify = vi.fn(async (_input: verdict.AgentRequest): Promise<verdict.AgentVerdict> => ({
    agent_purpose: "unknown",
    claimed: { uaTokens: [], signatureAgents: [] },
    verification: "no_signature",
    reason: "signature_headers_absent",
    signatures: [],
  }));
  vi.spyOn(verdict, "createVerifier").mockReturnValue(fakeVerifier(verify));
  const { post } = setup();
  const consistency = {
    "sec-ch-ua": '\"Chromium\";v=\"142\"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '\"Windows\"',
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
  };
  expect((await post("/e?raw=%2f&x=1", consistency)).statusCode).toBe(204);
  expect(verify).toHaveBeenCalledWith(
    {
      method: "POST",
      host: config.trackerHost,
      headers: expect.any(Array),
      clientIp: "127.0.0.1",
      target: "/e?raw=%2f&x=1",
    },
    { cacheOnly: true },
  );
  const original = verify.mock.calls[0]![0] as unknown as { headers: string[] };
  const values = new Map<string, string>();
  for (let i = 0; i < original.headers.length; i += 2)
    values.set(original.headers[i]!.toLowerCase(), original.headers[i + 1]!);
  for (const [name, value] of Object.entries(consistency)) expect(values.get(name)).toBe(value);
});

it("labels truncated signatures as unverified and obvious bots while forwarding both", async () => {
  const { post, hit, google } = setup();
  const headers = { ...signed[0]!.headers, signature: "sig1=:AAAA:" };
  for (const path of ["/e", "/d"]) {
    expect((await post(path, headers)).statusCode).toBe(204);
    expect(detail(hit(), 1)).toBe("none");
    expect(hit().get("ep.vv_type")).toBe("agent_unverified");
    expect((await post(path, { "user-agent": "Googlebot/2.1" })).statusCode).toBe(204);
  }
  expect(google).toHaveBeenCalledTimes(4);
});

it("removes detail as a last resort to deliver a near-limit non-item hit", () => {
  const url = new URL("https://www.google-analytics.com/g/collect?v=2&en=page_view");
  url.searchParams.set("ep.payload", "x".repeat(16320));
  url.searchParams.set("ep.vv_type", "agent_verified");
  url.searchParams.set(
    "ep.vv_detail",
    "openai|signature_valid|user_directed|signature_agent|human|final",
  );
  const request = collectRequest(url);
  expect(request).toBeDefined();
  const fields = new URLSearchParams(request!.body);
  expect(fields.get("ep.vv_type")).toBe("agent_verified");
  expect(fields.has("ep.vv_detail")).toBe(false);
});

it("anchors IP memory expiry to proof time before delivery waits", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1800000000000);
  vi.mocked(verdict.createVerifier).mockReturnValue(
    fakeVerifier(async () => ({
      verification: "ip_match",
      reason: "official_ip_range_match",
      agent_purpose: "crawler",
      claimed: { uaTokens: [], signatureAgents: [] },
      signatures: [],
      verified: { operator: "openai", method: "ip" },
    })),
  );
  const { createAgentLabeller } = await import("../src/server/agent-verification.js");
  const labeller = createAgentLabeller("tracker.example", { now: () => 1800000010 });
  try {
    const proof = await labeller.label({
      method: "GET",
      url: "/",
      ip: "192.0.2.1",
      raw: { rawHeaders: [] },
    } as unknown as import("fastify").FastifyRequest);
    expect(proof?.proofExpiresAt).toBe(1800001810);
    vi.setSystemTime(1800000600000);
    const { withLabels, createLabelMemory } = await import("../src/server/labels.js");
    const memory = createLabelMemory();
    withLabels({}, proof, { memory, key: "s" });
    vi.setSystemTime(1800001810000);
    expect(withLabels({ traffic_class: "human" }, undefined, { memory, key: "s" }).vv_type).toBe(
      "human",
    );
  } finally {
    labeller.close();
  }
});

it("keeps weak Chromium header mismatch local and preserves labels", async () => {
  const { createAgentLabeller } = await import("../src/server/agent-verification.js");
  const labeller = createAgentLabeller("tracker.example", {
    fetcher: async () => new Response(null, { status: 404 }),
  });
  try {
    const proof = await labeller.label({
      method: "GET",
      url: "/",
      ip: "127.0.0.1",
      raw: {
        rawHeaders: [
          "User-Agent",
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/142.0.0.0 Safari/537.36",
          "Accept",
          "text/html",
        ],
      },
    } as unknown as import("fastify").FastifyRequest);
    expect(proof?.evidence).toEqual(["header_mismatch"]);
    expect(proof?.verified).toBeUndefined();
    expect(
      verdict.visitorLabels({ verdict: proof, browserClass: "human", browserPhase: "final" }),
    ).toEqual({
      vv_type: "human",
      vv_detail: "none|no_signature|unknown|none|human|final",
    });
  } finally {
    labeller.close();
  }
});

it("collector never forwards local evidence or raw verification headers to GA4", async () => {
  const proof: verdict.AgentVerdict = {
    verification: "no_signature",
    reason: "signature_headers_absent",
    agent_purpose: "unknown",
    claimed: { uaTokens: [], signatureAgents: [] },
    signatures: [],
    evidence: ["header_mismatch"],
  };
  vi.mocked(verdict.createVerifier).mockReturnValue(fakeVerifier(async () => proof));
  const { post, hit, google } = setup();
  expect(
    (
      await post(
        "/e",
        { "x-private-diagnostic": "private-canary", "sec-ch-ua-platform": '"Linux"' },
        { traffic_class: "human", traffic_phase: "final" },
      )
    ).statusCode,
  ).toBe(204);
  expect(google).toHaveBeenCalledTimes(1);
  const payload = hit().toString();
  for (const secret of [
    "header_mismatch",
    "evidence",
    "private-canary",
    "sec-ch-ua",
    "x-private-diagnostic",
  ])
    expect(payload).not.toContain(secret);
  expect(hit().get("ep.vv_type")).toBe("human");
});

for (const verification of ["signature_valid", "ip_match"] as const)
  for (const purpose of ["user_directed", "crawler"] as const)
    it(`echoes only bounded current proof: ${verification}/${purpose}`, async () => {
      vi.mocked(verdict.createVerifier).mockReturnValue(
        fakeVerifier(async () => ({
          verification,
          agent_purpose: purpose,
          reason: "private-reason",
          claimed: { uaTokens: [], signatureAgents: [] },
          signatures: [],
          verified: {
            operator: "openai",
            method: verification === "ip_match" ? "ip" : "signature",
          },
        })),
      );
      const { app, post, google } = setup(true, {}, { verdictEcho: true });
      for (const route of ["/e", "/d"]) {
        const result = await post(route, { "x-secret": "private-value" });
        expect(result.statusCode).toBe(200);
        expect(result.headers["content-type"]).toContain("application/json");
        expect(result.json()).toEqual({
          vv: {
            v: 1,
            ttl: verification === "ip_match" ? expect.any(Number) : 0,
            type: purpose === "crawler" ? "crawler_verified" : "agent_verified",
            operator: "openai",
            verification,
            purpose,
          },
        });
        expect(result.body.length).toBeLessThan(200);
      }
      const now = Date.now();
      const payload = {
        event_id: crypto.randomUUID(),
        name: "page_view",
        client_id: "1.2",
        session_id: 1,
        session_started_ms: now,
        session_expires_ms: now + 1800000,
        timestamp_ms: now,
        consent: { analytics_storage: "granted" },
        params: {},
      };
      const request = {
        method: "POST" as const,
        url: "/e",
        headers: { origin: config.siteOrigin, "content-type": "application/json" },
        payload,
      };
      expect((await app.inject(request)).statusCode).toBe(200);
      const count = google.mock.calls.length;
      const duplicate = await app.inject(request);
      expect(duplicate.statusCode).toBe(204);
      expect(duplicate.body).toBe("");
      expect(google.mock.calls.length).toBe(count);
    });

it("defaults echo to verification and validates the explicit switch", () => {
  const env = { GA4_MEASUREMENT_ID: "G-TEST", COOKIE_SECRET: "s".repeat(64) };
  expect(configFromEnv(env).verdictEcho).toBe(false);
  expect(
    configFromEnv({ ...env, AGENT_VERIFICATION: "on", TRACKER_DOMAIN: "tracker.example" })
      .verdictEcho,
  ).toBe(true);
  expect(
    configFromEnv({
      ...env,
      AGENT_VERIFICATION: "on",
      TRACKER_DOMAIN: "tracker.example",
      VERDICT_ECHO: "off",
    }).verdictEcho,
  ).toBe(false);
  expect(() => configFromEnv({ ...env, VERDICT_ECHO: "bad" })).toThrow("VERDICT_ECHO");
});
it("default app echoes verified identity and off keeps 204", async () => {
  vi.mocked(verdict.createVerifier).mockReturnValue(
    fakeVerifier(async () => ({
      verification: "signature_valid",
      agent_purpose: "user_directed",
      reason: "ok",
      claimed: { uaTokens: [], signatureAgents: [] },
      signatures: [],
      verified: { operator: "openai", method: "signature" },
    })),
  );
  const { post } = setup();
  expect((await post("/e")).statusCode).toBe(204);
  // undefined exercises createApp's default rather than configFromEnv.
  const enabled = setup(true, {}, { verdictEcho: undefined });
  expect((await enabled.post("/e")).statusCode).toBe(200);
});

for (const verification of ["no_signature", "signature_invalid"] as const)
  it(`echo enabled still returns 204 for ${verification}`, async () => {
    vi.mocked(verdict.createVerifier).mockReturnValue(
      fakeVerifier(async () => ({
        verification,
        agent_purpose: "unknown",
        reason: "private-error",
        claimed: { uaTokens: [], signatureAgents: [] },
        signatures: [],
      })),
    );
    const { post } = setup(true, {}, { verdictEcho: true });
    for (const route of ["/e", "/d"]) {
      const r = await post(route);
      expect(r.statusCode).toBe(204);
      expect(r.body).toBe("");
    }
  });
it("verified retry responses stay 503 and concurrent duplicates stay 204", async () => {
  vi.mocked(verdict.createVerifier).mockReturnValue(
    fakeVerifier(async () => ({
      verification: "signature_valid",
      agent_purpose: "user_directed",
      reason: "ok",
      claimed: { uaTokens: [], signatureAgents: [] },
      signatures: [],
      verified: { operator: "openai", method: "signature" },
    })),
  );
  const { app, google } = setup(true, {}, { verdictEcho: true });
  const now = Date.now();
  const payload = {
    event_id: crypto.randomUUID(),
    name: "page_view",
    client_id: "1.2",
    session_id: 1,
    session_started_ms: now,
    session_expires_ms: now + 1800000,
    timestamp_ms: now,
    consent: { analytics_storage: "granted" },
    params: {},
  };
  const request = {
    method: "POST" as const,
    url: "/e",
    headers: { origin: config.siteOrigin, "content-type": "application/json" },
    payload,
  };
  google.mockImplementation(async () => new Response(null, { status: 503 }));
  expect((await app.inject(request)).statusCode).toBe(503);
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  google.mockImplementation(async () => {
    await wait;
    return new Response(null, { status: 204 });
  });
  const first = app.inject(request);
  await vi.waitFor(() => expect(google.mock.calls.length).toBeGreaterThan(1));
  const twin = app.inject(request);
  await new Promise((r) => setTimeout(r, 10));
  release();
  const results = await Promise.all([first, twin]);
  expect(results.map((r) => r.statusCode)).toEqual([200, 204]);
});

it("caps and rounds TTL to the remaining proof lifetime", async () => {
  const { verdictEcho } = await import("../src/server/labels.js");
  const proof: import("../src/server/agent-verification.js").AgentFields = {
    verification: "signature_valid",
    agent_purpose: "user_directed",
    reason: "ok",
    claimed: { uaTokens: [], signatureAgents: [] },
    signatures: [],
    verified: { operator: "openai", method: "signature", expiresAt: 1100.9 },
  };
  expect(verdictEcho(proof, 1000)?.ttl).toBe(100);
  expect(verdictEcho(proof, -10000)?.ttl).toBe(1800);
  expect(verdictEcho(proof, 1101)?.ttl).toBe(0);
  expect(verdictEcho({ ...proof, proofExpiresAt: 1007 }, 1000)?.ttl).toBe(7);
  expect(
    verdictEcho({ ...proof, verified: { ...proof.verified!, expiresAt: undefined } }, 1000)?.ttl,
  ).toBe(0);
});
it("computes wire TTL after delivery waits, not at verification time", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1800000000000);
  vi.mocked(verdict.createVerifier).mockReturnValue(
    fakeVerifier(async () => ({
      verification: "signature_valid",
      agent_purpose: "user_directed",
      reason: "ok",
      claimed: { uaTokens: [], signatureAgents: [] },
      signatures: [],
      verified: { operator: "openai", method: "signature", expiresAt: 1800000010 },
    })),
  );
  const { post, google } = setup(true, {}, { verdictEcho: true });
  let finish!: (r: Response) => void;
  google.mockImplementation(
    () =>
      new Promise<Response>((r) => {
        finish = r;
      }),
  );
  const pending = post("/e");
  await vi.waitFor(() => expect(google).toHaveBeenCalledTimes(1));
  vi.setSystemTime(1800000007000);
  finish(new Response(null, { status: 204 }));
  expect((await pending).json().vv.ttl).toBe(3);
});
it("never echoes a successful hit withdrawn during delivery", async () => {
  vi.mocked(verdict.createVerifier).mockReturnValue(
    fakeVerifier(async () => ({
      verification: "signature_valid",
      agent_purpose: "user_directed",
      reason: "ok",
      claimed: { uaTokens: [], signatureAgents: [] },
      signatures: [],
      verified: { operator: "openai", method: "signature", expiresAt: Date.now() / 1000 + 300 },
    })),
  );
  const { post, google, app } = setup(true, {}, { verdictEcho: true });
  let finish!: (r: Response) => void;
  google.mockImplementation(
    () =>
      new Promise<Response>((r) => {
        finish = r;
      }),
  );
  const pending = post("/e");
  await vi.waitFor(() => expect(google).toHaveBeenCalledTimes(1));
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/p",
        headers: { origin: config.siteOrigin, "content-type": "application/json" },
        payload: { client_id: "123.456" },
      })
    ).statusCode,
  ).toBe(204);
  finish(new Response(null, { status: 204 }));
  const r = await pending;
  expect(r.statusCode).toBe(204);
  expect(r.body).toBe("");
  expect(r.headers["set-cookie"]).toBeUndefined();
});
for (const enabled of [true, false])
  it(`collector script enable flag only exists when echo is on: ${enabled}`, async () => {
    const { createApp: builtApp } = (await import(
      new URL("../dist/server/app.js", import.meta.url).href
    )) as { createApp: typeof createApp };
    const app = builtApp(
      { ...config, agentVerification: false, verdictEcho: enabled },
      async () => new Response(null, { status: 204 }),
    );
    apps.push(app);
    const result = await app.inject({ method: "GET", url: "/s.js" });
    expect(result.statusCode).toBe(200);
    expect(result.body.startsWith('document.currentScript.dataset.verdictEcho="on";')).toBe(
      enabled,
    );
  });

it.each(["cookie", "proxy", "traffic"])(
  "retains signed retry with changed %s and rejects a different event replay",
  async (change) => {
    const warm = spyOnWarm();
    const request = signed[0]!;
    const clock = Date.parse(request.ts) / 1000;
    const { app, google, hit } = setup(true, {
      now: () => clock,
      fetcher: async (url: string) =>
        url === chatgpt ? new Response(directory) : new Response(null, { status: 404 }),
    });
    await warm.mock.results[0]!.value;
    google.mockResolvedValueOnce(new Response(null, { status: 500 }));
    const now = Date.now();
    const payload = {
      name: "purchase",
      params: {},
      client_id: "123.456",
      session_id: 123,
      event_id: crypto.randomUUID(),
      timestamp_ms: now,
      session_started_ms: now,
      session_expires_ms: now + 1800000,
      consent: { analytics_storage: "granted" },
    };
    const post = (body: typeof payload, extra: Record<string, string> = {}) =>
      app.inject({
        method: "POST",
        url: "/e",
        headers: {
          ...request.headers,
          ...extra,
          origin: config.siteOrigin,
          "content-type": "application/json",
        },
        payload: body,
      });
    expect((await post(payload)).statusCode).toBe(503);
    expect(hit().get("ep.vv_type")).toBe("agent_verified");
    const extra: Record<string, string> =
      change === "cookie"
        ? { cookie: "unrelated=changed" }
        : change === "proxy"
          ? { "x-request-id": "two", "cf-ray": "new" }
          : {};
    const retry =
      change === "traffic"
        ? { ...payload, params: { traffic_class: "human", traffic_phase: "final" } }
        : payload;
    expect((await post(retry, extra)).statusCode).toBe(204);
    expect(hit().get("ep.vv_type")).toBe("agent_verified");
    expect((await post({ ...payload, event_id: crypto.randomUUID() })).statusCode).toBe(204);
    expect(hit().get("ep.vv_type")).toBe("agent_unverified");
    expect(detail(hit(), 1)).toBe("none");
  },
);

it("obvious UA evidence never overrides verified identity or an invalid signature", async () => {
  for (const verification of ["signature_valid", "signature_invalid"] as const) {
    vi.mocked(verdict.createVerifier).mockReturnValue(
      fakeVerifier(async () => ({
        verification,
        reason: "test",
        agent_purpose: "user_directed",
        claimed: { uaTokens: [], signatureAgents: [] },
        signatures: [],
        ...(verification === "signature_valid"
          ? { verified: { operator: "openai", method: "signature" as const } }
          : {}),
      })),
    );
    const { post, hit, app } = setup();
    for (const path of ["/e", "/d"]) {
      expect((await post(path, { "user-agent": "HeadlessChrome" })).statusCode).toBe(204);
      expect(hit().get("ep.vv_type")).toBe(
        verification === "signature_valid" ? "agent_verified" : "bot_spoofed",
      );
    }
    expect((await app.inject("/health")).json().google.botsLabelled).toBe(
      verification === "signature_valid" ? 0 : 2,
    );
  }
});

it("keeps bot_spoofed for a full cryptographic mismatch against a known immutable key", async () => {
  const warm = spyOnWarm();
  const request = signed[0]!;
  const { post, hit } = setup(true, {
    now: () => Date.parse(request.ts) / 1000,
    fetcher: async (url: string) =>
      url === chatgpt ? new Response(directory) : new Response(null, { status: 404 }),
  });
  await warm.mock.results[0]!.value;
  const signature = request.headers.signature!;
  const base64 = signature.match(/:([^:]+):/)![1]!;
  const bytes = Buffer.from(base64, "base64");
  bytes[0] = bytes[0]! ^ 1;
  const headers = {
    ...request.headers,
    signature: signature.replace(base64, bytes.toString("base64")),
  };
  for (const path of ["/e", "/d"]) {
    expect((await post(path, headers)).statusCode).toBe(204);
    expect(detail(hit(), 1)).toBe("signature_invalid");
    expect(hit().get("ep.vv_type")).toBe("bot_spoofed");
    expect(detail(hit(), 0)).toBe("none");
  }
});
