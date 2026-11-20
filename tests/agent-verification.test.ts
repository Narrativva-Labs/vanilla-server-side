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
  vi.mocked(verdict.createVerifier).mockImplementation(
    (await vi.importActual<typeof verdict>("visitor-verdict-server")).createVerifier,
  );
  vi.clearAllMocks();
  vi.useRealTimers();
});
function setup(enabled = true, options: Parameters<typeof createApp>[2] = {}) {
  const google = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const app = createApp({ ...config, agentVerification: enabled }, google, options);
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
  const fetcher = vi.fn();
  const { post, google, hit } = setup(false, { fetcher });
  for (const path of ["/e", "/d"]) {
    expect((await post(path, signed[0]!.headers)).statusCode).toBe(204);
    for (const name of ["agent_claim", "agent_operator", "agent_verification"])
      expect(hit().has(`ep.${name}`)).toBe(false);
  }
  expect(construct).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
  expect(google).toHaveBeenCalledTimes(2);
});

it("verifies every captured POST signature on both delivery paths and reuses one verifier/cache", async () => {
  const construct = vi.spyOn(verdict, "createVerifier");
  const fetcher = vi.fn(async (url: string) => {
    expect(url).toBe("https://chatgpt.com/.well-known/http-message-signatures-directory");
    return new Response(directory, { headers: { "cache-control": "max-age=3600" } });
  });
  let clock = 0;
  const { post, hit, google } = setup(true, { fetcher, now: () => clock });
  for (const request of signed) {
    clock = Date.parse(request.ts) / 1000;
    for (const path of ["/e", "/d"]) {
      expect((await post(path, request.headers)).statusCode).toBe(204);
      expect(hit().get("ep.agent_verification")).toBe("signature_valid");
      expect(hit().get("ep.agent_operator")).toBe("openai");
      expect(hit().get("ep.agent_claim")).toBe("signature_agent");
      expect(String(google.mock.calls.at(-1))).not.toContain(request.headers.signature);
    }
  }
  expect(construct).toHaveBeenCalledTimes(1);
  expect(construct.mock.calls[0]![0].reverseDns).toEqual({ enabled: false });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("labels unsigned visitors without network access and preserves the parameter limit", async () => {
  const fetcher = vi.fn();
  const { post, hit } = setup(true, { fetcher });
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
            agent_claim: "spoofed",
            google_reserved: "bad",
          },
        )
      ).statusCode,
    ).toBe(204);
    expect(hit().get("ep.agent_verification")).toBe("no_signature");
    expect(hit().get("ep.agent_operator")).toBe("none");
    expect(hit().get("ep.agent_claim")).toBe("none");
    expect(hit().has("ep.google_reserved")).toBe(false);
    expect([...hit().keys()].filter((key) => /^ep[n]?\./.test(key)).length).toBeLessThanOrEqual(25);
  }
  expect(fetcher).not.toHaveBeenCalled();
});

for (const failure of ["throw", "reject", "timeout"] as const) {
  it(`sends both hits without labels after a verifier ${failure}`, async () => {
    const verify = vi.fn(() => {
      if (failure === "throw") throw new Error("failure");
      if (failure === "reject") return Promise.reject(new Error("failure"));
      return new Promise<verdict.AgentVerdict>(() => {});
    });
    vi.spyOn(verdict, "createVerifier").mockReturnValue({ verify });
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
  const verify = vi.fn(async (): Promise<verdict.AgentVerdict> => ({
    claimed: { uaTokens: [], signatureAgents: [] },
    verification: "no_signature",
    reason: "signature_headers_absent",
    signatures: [],
  }));
  vi.spyOn(verdict, "createVerifier").mockReturnValue({ verify });
  const { post } = setup();
  expect((await post("/e?raw=%2f&x=1")).statusCode).toBe(204);
  expect(verify).toHaveBeenCalledWith({
    method: "POST",
    host: config.trackerHost,
    headers: expect.any(Array),
    clientIp: "127.0.0.1",
    target: "/e?raw=%2f&x=1",
  });
});

it("labels an invalid signature and still sends the hit; obvious bots stay filtered", async () => {
  const { post, hit, google } = setup();
  const headers = { ...signed[0]!.headers, signature: "sig1=:AAAA:" };
  for (const path of ["/e", "/d"]) {
    expect((await post(path, headers)).statusCode).toBe(204);
    expect(hit().get("ep.agent_verification")).toBe("signature_invalid");
    expect((await post(path, { "user-agent": "Googlebot/2.1" })).statusCode).toBe(204);
  }
  expect(google).toHaveBeenCalledTimes(2);
});

it("omits optional labels when they would push a deliverable body over 16 KiB", () => {
  const url = new URL("https://www.google-analytics.com/g/collect?v=2&en=page_view");
  url.searchParams.set("ep.payload", "x".repeat(16320));
  url.searchParams.set("ep.agent_verification", "signature_valid");
  url.searchParams.set("ep.agent_operator", "openai");
  url.searchParams.set("ep.agent_claim", "signature_agent");
  const request = collectRequest(url, true);
  expect(request).toBeDefined();
  const body = new URLSearchParams(request!.body);
  expect(body.get("ep.payload")).toHaveLength(16320);
  expect(body.has("ep.agent_verification")).toBe(false);
  expect(body.has("ep.agent_operator")).toBe(false);
  expect(body.has("ep.agent_claim")).toBe(false);
});
