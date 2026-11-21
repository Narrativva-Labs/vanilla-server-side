import { expect, it, vi } from "vitest";
import { configFromEnv } from "../src/server/config.js";
import { createApp } from "../src/server/app.js";

const env = { GA4_MEASUREMENT_ID: "G-TEST", COOKIE_SECRET: "s".repeat(64) };
const site = {
  measurementId: "G-TEST",
  cookieSecret: "s".repeat(64),
  siteOrigin: "https://shop.test",
};
const ping = {
  name: "page_view",
  consent: { analytics_storage: "denied" },
  client_id: "1.2",
  session_id: 123,
  page_id: "123",
  hit_index: 1,
  params: {},
};
it("defaults and explicit privacy settings validate at startup even with pings disabled", () => {
  expect(configFromEnv(env)).toMatchObject({ deniedPingIp: "full", deniedPingUserAgent: true });
  for (const value of ["full", "truncated", "off"])
    expect(configFromEnv({ ...env, DENIED_PING_IP: value }).deniedPingIp).toBe(value);
  for (const value of ["on", "off"])
    expect(configFromEnv({ ...env, DENIED_PING_USER_AGENT: value }).deniedPingUserAgent).toBe(
      value === "on",
    );
  for (const [key, values] of Object.entries({
    DENIED_PING_IP: ["on", "FULL", " full"],
    DENIED_PING_USER_AGENT: ["full", "OFF", " off"],
  }))
    for (const value of values)
      expect(() => configFromEnv({ ...env, DENIED_PINGS: "off", [key]: value })).toThrow(key);
});
it.each([
  ["full", "192.0.2.123", "192.0.2.123"],
  ["full", "2001:db8:abcd:1234::1", "2001:db8:abcd:1234::1"],
  ["full", "::ffff:192.0.2.123", "::ffff:192.0.2.123"],
  ["truncated", "192.0.2.123", "192.0.2.0"],
  ["truncated", "2001:db8:abcd:1234:5678:90ab:cdef:1234", "2001:db8:abcd::"],
  ["truncated", "2001:db8::1234", "2001:db8::"],
  ["truncated", "::1", "::"],
  ["truncated", "fe80::1234%en0", "fe80::"],
  ["truncated", "::ffff:192.0.2.123", "192.0.2.0"],
  ["truncated", "0:0:0:0:0:ffff:c000:027b", "192.0.2.0"],
  ["off", "192.0.2.123", null],
  ["off", "2001:db8::1234", null],
  ["off", "::ffff:192.0.2.123", null],
] as const)("%s forwards %s as %s only for /d", async (mode, ip, expected) => {
  const google = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const app = createApp({ ...site, deniedPingIp: mode, deniedPingUserAgent: false }, google);
  try {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/d",
          remoteAddress: ip,
          headers: { origin: site.siteOrigin, "user-agent": "Browser/private" },
          payload: ping,
        })
      ).statusCode,
    ).toBe(204);
    expect(new URL(String(google.mock.calls[0]![0])).searchParams.get("_uip")).toBe(expected);
    expect(new Headers(google.mock.calls[0]![1]?.headers).get("user-agent")).toBe("unknown");
    const now = Date.now();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/e",
          remoteAddress: ip,
          headers: { origin: site.siteOrigin, "user-agent": "Browser/private" },
          payload: {
            event_id: crypto.randomUUID(),
            name: "generate_lead",
            client_id: "1.2",
            session_id: 123,
            session_started_ms: now,
            session_expires_ms: now + 1800000,
            timestamp_ms: now,
            consent: { analytics_storage: "granted" },
            params: {},
          },
        })
      ).statusCode,
    ).toBe(204);
    expect(google.mock.calls).toHaveLength(2);
    expect(new URL(String(google.mock.calls[1]![0])).searchParams.get("_uip")).toBe(ip);
    expect(new Headers(google.mock.calls[1]![1]?.headers).get("user-agent")).toBe(
      "Browser/private",
    );
  } finally {
    await app.close();
  }
});
it("default /d forwards the browser UA", async () => {
  const google = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const app = createApp(site, google);
  try {
    await app.inject({
      method: "POST",
      url: "/d",
      headers: { origin: site.siteOrigin, "user-agent": "Browser/private" },
      payload: ping,
    });
    expect(new Headers(google.mock.calls[0]![1]?.headers).get("user-agent")).toBe(
      "Browser/private",
    );
  } finally {
    await app.close();
  }
});
it("native fetch defaults to node; the neutral override sends no runtime or browser identity", async () => {
  // Intercept native undici after it constructs defaults, without opening a socket.
  await fetch("data:,");
  const key = Symbol.for("undici.globalDispatcher.1");
  const globals = globalThis as unknown as Record<symbol, unknown>;
  const original = globals[key];
  const agents: (string | null)[] = [];
  globals[key] = {
    dispatch(
      options: { headers: HeadersInit },
      handler: {
        onConnect(abort: () => void): void;
        onHeaders(status: number, headers: string[], resume: () => void, statusText: string): void;
        onComplete(trailers: string[]): void;
      },
    ) {
      agents.push(new Headers(options.headers).get("user-agent"));
      handler.onConnect(() => {});
      handler.onHeaders(204, [], () => {}, "No Content");
      handler.onComplete([]);
      return true;
    },
  };
  try {
    await fetch("http://example.invalid");
    const app = createApp({ ...site, deniedPingUserAgent: false });
    try {
      await app.inject({
        method: "POST",
        url: "/d",
        headers: { origin: site.siteOrigin, "user-agent": "Browser/private" },
        payload: ping,
      });
    } finally {
      await app.close();
    }
    expect(agents).toEqual(["node", "unknown"]);
  } finally {
    globals[key] = original;
  }
});
it.each(["truncated", "off"] as const)(
  "%s retains independent rate limits for real IPs sharing a /24",
  async (mode) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const google = vi.fn<typeof fetch>(async () => {
      await held;
      return new Response(null, { status: 204 });
    });
    const app = createApp({ ...site, deniedPingIp: mode }, google);
    const post = (ip: string) =>
      app.inject({
        method: "POST",
        url: "/d",
        remoteAddress: ip,
        headers: { origin: site.siteOrigin },
        payload: ping,
      });
    const pending = Array.from({ length: 100 }, () => Promise.resolve(post("192.0.2.1")));
    try {
      await vi.waitFor(() => expect(google).toHaveBeenCalledTimes(100));
      expect((await post("192.0.2.1")).statusCode).toBe(429);
      const neighbor = Promise.resolve(post("192.0.2.2"));
      await vi.waitFor(() => expect(google).toHaveBeenCalledTimes(101));
      release();
      expect((await neighbor).statusCode).toBe(204);
      expect((await Promise.all(pending)).every((response) => response.statusCode === 204)).toBe(
        true,
      );
    } finally {
      release();
      await Promise.all(pending);
      await app.close();
    }
  },
);
