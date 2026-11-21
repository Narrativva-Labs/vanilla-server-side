import { expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { createTracker } from "../src/client/tracker.js";
const config = {
  measurementId: "G-TEST",
  cookieSecret: "s".repeat(64),
  siteOrigin: "https://example.com",
};
const secret = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
function event(token?: string, traffic_class = "human") {
  const now = Date.now();
  return {
    event_id: crypto.randomUUID(),
    bootstrap_token: token,
    client_id: "123.456",
    session_id: 1,
    session_started_ms: now,
    session_expires_ms: now + 1800000,
    timestamp_ms: now,
    name: "page_view",
    consent: { analytics_storage: "granted" },
    params: { traffic_class },
  };
}
function setup(gate?: Promise<void>) {
  const hits: URLSearchParams[] = [];
  let started!: () => void;
  const start = new Promise<void>((resolve) => (started = resolve));
  const app = createApp(config, async (url) => {
    hits.push(new URL(String(url)).searchParams);
    if (hits.length === 1) {
      started();
      await gate;
    }
    return new Response(null, { status: 204 });
  });
  const post = (payload: object, cookie = "", url = "/e") =>
    app.inject({
      method: "POST",
      url,
      headers: { origin: config.siteOrigin, cookie },
      payload,
    });
  return { app, hits, post, start };
}
it.each([undefined, other])(
  "client ID with token %s cannot recover identity or sticky evidence",
  async (token) => {
    const { app, hits, post } = setup();
    try {
      const victim = await post(event(secret, "automated"));
      const attacker = await post(event(token));
      await post(event(secret));
      expect(victim.statusCode).toBe(204);
      expect(attacker.statusCode).toBe(204);
      expect(hits[1]!.get("cid")).not.toBe(hits[0]!.get("cid"));
      expect(attacker.headers["set-cookie"]).not.toBe(victim.headers["set-cookie"]);
      expect(hits.map((h) => h.get("ep.vv_type"))).toEqual([
        "bot_automation",
        "human",
        "bot_automation",
      ]);
      expect(hits[2]!.get("cid")).toBe(hits[0]!.get("cid"));
    } finally {
      await app.close();
    }
  },
);
it("preseeding a public client ID does not fix the victim identity", async () => {
  const { app, hits, post } = setup();
  try {
    await post(event(other, "automated"));
    await post(event(secret));
    expect(hits[1]!.get("cid")).not.toBe(hits[0]!.get("cid"));
    expect(hits[1]!.get("ep.vv_type")).toBe("human");
  } finally {
    await app.close();
  }
});
it("parallel first hits share one client, session, first_visit and session_start", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { app, hits, post, start } = setup(gate);
  try {
    const first = post(event(secret));
    await start;
    const second = post({ ...event(secret), name: "purchase" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hits).toHaveLength(1);
    release();
    const responses = await Promise.all([first, second]);
    expect(responses.map((r) => r.statusCode)).toEqual([204, 204]);
    await post(event(), String(responses[0]!.headers["set-cookie"]));
    expect(hits).toHaveLength(3);
    expect(new Set(hits.map((h) => h.get("cid"))).size).toBe(1);
    expect(new Set(hits.map((h) => h.get("sid"))).size).toBe(1);
    expect(hits.filter((h) => h.get("_fv") === "1")).toHaveLength(1);
    expect(hits.filter((h) => h.get("_ss") === "1")).toHaveLength(1);
    expect(hits.every((h) => !h.toString().includes(secret))).toBe(true);
  } finally {
    release();
    await app.close();
  }
});
it("legacy requests without a token never join by client ID alone", async () => {
  const { app, hits, post } = setup();
  try {
    await post(event());
    await post(event());
    expect(hits[0]!.get("cid")).not.toBe(hits[1]!.get("cid"));
  } finally {
    await app.close();
  }
});
it("denied events stay blocked and denied pings set no cookie", async () => {
  const { app, hits, post } = setup();
  try {
    const denied = await post({ ...event(secret), consent: { analytics_storage: "denied" } });
    expect(denied.statusCode).toBe(403);
    expect(hits).toHaveLength(0);
    expect(denied.headers["set-cookie"]).toBeUndefined();
    const ping = await post(
      {
        client_id: "1.2",
        session_id: 1,
        page_id: "3",
        hit_index: 1,
        name: "page_view",
        params: {},
        consent: { analytics_storage: "denied" },
      },
      "",
      "/d",
    );
    expect(ping.statusCode).toBe(204);
    expect(ping.headers["set-cookie"]).toBeUndefined();
    expect(hits).toHaveLength(1);
  } finally {
    await app.close();
  }
});
it("tracker shares secret across exit and queue, resets on withdrawal, keeps pings token-free", async () => {
  const sent: { path: string; body: Record<string, unknown>; credentials: unknown }[] = [];
  const tracker = createTracker(
    "https://example.com/e",
    {
      href: () => "https://example.com/",
      referrer: () => "",
      warn: () => {},
      now: Date.now,
      uuid: () => crypto.randomUUID(),
      fetch: async (url, init) => {
        sent.push({
          path: new URL(String(url)).pathname,
          body: JSON.parse(String(init?.body)),
          credentials: init?.credentials,
        });
        return new Response(null, { status: 204 });
      },
    },
    new Set(["purchase"]),
  );
  tracker.update({ analytics_storage: "denied" });
  await tracker.flush();
  expect(sent.every((s) => s.body.bootstrap_token === undefined)).toBe(true);
  expect(sent.filter((s) => s.path === "/d").every((s) => s.credentials === "omit")).toBe(true);
  tracker.update({ analytics_storage: "granted" });
  await tracker.flush();
  tracker.exit(100);
  tracker.track("purchase");
  await tracker.flush();
  const granted = sent.filter((s) => s.path === "/e");
  expect(granted).toHaveLength(3);
  const token = granted[0]!.body.bootstrap_token;
  expect(token).toMatch(/^[0-9a-f-]{36}$/);
  expect(granted.every((s) => s.body.bootstrap_token === token)).toBe(true);
  tracker.update({ analytics_storage: "denied" });
  tracker.update({ analytics_storage: "granted" });
  await tracker.flush();
  expect(sent.filter((s) => s.path === "/e").at(-1)!.body.bootstrap_token).not.toBe(token);
  expect(
    sent.filter((s) => s.path === "/p").every((s) => s.body.bootstrap_token === undefined),
  ).toBe(true);
});

it("the secret is bound to its browser client ID and a signed cookie takes precedence", async () => {
  const { app, hits, post } = setup();
  try {
    const first = await post(event(secret));
    const second = await post({ ...event(secret), client_id: "789.123" });
    expect(hits[1]!.get("cid")).not.toBe(hits[0]!.get("cid"));
    await post(event(secret), String(second.headers["set-cookie"]));
    expect(hits[2]!.get("cid")).toBe(hits[1]!.get("cid"));
    expect(first.headers["set-cookie"]).toBeDefined();
  } finally {
    await app.close();
  }
});
it.each(["", "123.456", "x".repeat(1000)])(
  "malformed bootstrap secret %s is rejected",
  async (token) => {
    const { app, hits, post } = setup();
    try {
      expect((await post(event(token))).statusCode).toBe(400);
      expect(hits).toHaveLength(0);
    } finally {
      await app.close();
    }
  },
);
