import { afterEach, expect, it, vi } from "vitest";
import { page } from "./browser-fixture.js";
import { createApp } from "../src/server/app.js";
import { createTracker } from "../src/client/tracker.js";

const settle = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
const publication = (traffic_class = "suspicious", traffic_phase = "final") => ({
  event: "traffic_class",
  traffic_class,
  traffic_phase,
  traffic_agent: "openai",
  traffic_score: 6,
  traffic_signals: ["UB"],
  traffic_version: "1.2.0",
  private: "discard",
  ecommerce: { value: 123 },
});
const hits = (p: ReturnType<typeof page>, path: string) =>
  p.fetcher.mock.calls
    .filter(([url]) => new URL(String(url)).pathname === path)
    .map(([, init]) => ({ init, body: JSON.parse(String(init?.body)) }));

for (const consent of ["granted", "denied"])
  it(`sends one whitelisted keepalive update while hidden with ${consent} consent`, async () => {
    const p = page();
    p.command("consent", "update", { analytics_storage: consent });
    await settle();
    p.doc.visibilityState = "hidden";
    p.doc.dispatchEvent(new Event("visibilitychange"));
    p.host.dataLayer.push(publication());
    p.host.dataLayer.push(publication(), publication("declared_agent", "agent"));
    p.host.dispatchEvent(new Event("pagehide"));
    await settle();
    const updates = hits(p, consent === "granted" ? "/e" : "/d").filter(
      ({ body }) => body.name === "traffic_class",
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]!.body.params).toEqual({
      traffic_class: "suspicious",
      traffic_phase: "final",
    });
    expect(updates[0]!.init).toMatchObject({
      keepalive: true,
      credentials: consent === "granted" ? "include" : "omit",
    });
    expect(p.cookieReads()).toBe(0);
    p.host.history.pushState({}, "", "https://shop.example/next");
    p.host.dataLayer.push(publication());
    await settle();
    expect(
      hits(p, consent === "granted" ? "/e" : "/d").filter(
        ({ body }) => body.name === "traffic_class",
      ),
    ).toHaveLength(1);
  });

it("ignores initial, legacy, malformed and addressed events without consuming the update", async () => {
  const p = page([], { dataset: { events: "traffic_class" } });
  p.command("consent", "update", { analytics_storage: "granted" });
  p.host.dataLayer.push(
    { event: "traffic_class", traffic_class: "human" },
    publication("human", "initial"),
    publication("robot"),
    publication("human", "agent"),
  );
  p.command("event", "traffic_class", { ...publication(), send_to: "G-OTHER" });
  await settle();
  expect(hits(p, "/e").filter(({ body }) => body.name === "traffic_class")).toHaveLength(0);
  p.host.dataLayer.push(publication("declared_agent", "agent"), publication());
  await settle();
  expect(
    hits(p, "/e")
      .filter(({ body }) => body.name === "traffic_class")
      .map(({ body }) => body.params),
  ).toEqual([{ traffic_class: "declared_agent", traffic_phase: "agent", traffic_agent: "openai" }]);
});

it("replays an earlier publication using chronological consent and the event's own labels", async () => {
  const p = page([["consent", "update", { analytics_storage: "granted" }], publication()], {
    setup(host) {
      host.__visitorVerdict = Object.freeze({ class: "human", phase: "initial" });
    },
  });
  await settle();
  expect(
    hits(p, "/e")
      .filter(({ body }) => body.name === "traffic_class")
      .map(({ body }) => body.params),
  ).toEqual([{ traffic_class: "suspicious", traffic_phase: "final" }]);
});

it("subscribes to the configured custom layer without an initial-class wait", async () => {
  const p = page([], {
    setup(host) {
      host.visitorVerdictConfig = { dataLayerName: "verdicts" };
    },
  });
  p.command("consent", "update", { analytics_storage: "granted" });
  (p.host as unknown as { verdicts: unknown[] }).verdicts.push(publication());
  await settle();
  expect(hits(p, "/e").filter(({ body }) => body.name === "traffic_class")).toHaveLength(1);
});

it("waits for a consent decision and preserves the original update instead of later runtime labels", async () => {
  const p = page();
  p.host.dataLayer.push(publication());
  await settle();
  expect(p.fetcher).not.toHaveBeenCalled();
  p.command("consent", "update", { analytics_storage: "granted" });
  await settle();
  expect(hits(p, "/e").filter(({ body }) => body.name === "traffic_class")).toHaveLength(1);
});

it("does not send denied updates when pings are disabled", async () => {
  const p = page([], { dataset: { pings: "off" } });
  p.command("consent", "update", { analytics_storage: "denied" });
  p.host.dataLayer.push(publication());
  await settle();
  expect(hits(p, "/d")).toHaveLength(0);
  expect(hits(p, "/e")).toHaveLength(0);
});

it("the update bypasses a slow ordinary event and never retries its best-effort request", async () => {
  const requests: { name: string; params: object }[] = [];
  const tracker = createTracker(
    "https://tracker.example/e",
    {
      href: () => "https://shop.example",
      referrer: () => "",
      now: Date.now,
      uuid: () => crypto.randomUUID(),
      warn: vi.fn(),
      fetch: vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        if (body.name === "page_view") return new Promise<Response>(() => {});
        throw Error("offline");
      }),
    },
    new Set(),
  );
  tracker.update({ analytics_storage: "granted" });
  tracker.track("traffic_class", publication());
  tracker.track("traffic_class", publication());
  await tracker.flush();
  expect(requests.map((r) => r.name)).toEqual(["page_view", "traffic_class"]);
});

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
for (const denied of [false, true])
  for (const [value, phase, type] of [
    ["suspicious", "final", "bot_suspicious"],
    ["declared_agent", "agent", "agent_unverified"],
  ])
    it(`forwards the dedicated event and updates ${denied ? "page" : "session"} memory for ${value} with a server whitelist`, async () => {
      const google = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
      const app = createApp(
        {
          cookieSecret: "s".repeat(64),
          measurementId: "G-TEST",
          siteOrigin: "https://shop.example",
          allowedEvents: ["generate_lead"],
        },
        google,
      );
      apps.push(app);
      let cookie: string | undefined;
      const now = Date.now();
      const post = async (name: string, params: object, hit_index = 1) => {
        const response = await app.inject({
          method: "POST",
          url: denied ? "/d" : "/e",
          headers: {
            origin: "https://shop.example",
            "user-agent": "Chrome/140.0",
            ...(cookie ? { cookie } : {}),
          },
          payload: {
            name,
            client_id: "123.456",
            session_id: 123,
            page_id: "123",
            hit_index,
            consent: { analytics_storage: denied ? "denied" : "granted" },
            params,
            ...(!denied
              ? {
                  event_id: crypto.randomUUID(),
                  timestamp_ms: now,
                  session_started_ms: now,
                  session_expires_ms: now + 1800000,
                }
              : {}),
          },
        });
        const setCookie = response.headers["set-cookie"];
        if (setCookie) cookie = String(setCookie).split(";")[0];
        return response;
      };
      expect(
        (await post("page_view", { traffic_class: "human", traffic_phase: "initial" })).statusCode,
      ).toBe(204);
      expect(
        (
          await post(
            "traffic_class",
            { ...publication(value, phase), vv_type: "agent_verified" },
            2,
          )
        ).statusCode,
      ).toBe(204);
      const last = () => {
        const [url, init] = google.mock.calls.at(-1)!;
        return new URLSearchParams(new URL(String(url)).search + "&" + String(init?.body ?? ""));
      };
      expect(last().get("en")).toBe("traffic_class");
      expect(last().get("ep.traffic_class")).toBe(value);
      expect(last().get("ep.traffic_phase")).toBe(phase);
      expect(last().get("ep.traffic_agent")).toBe(value === "declared_agent" ? "openai" : null);
      expect(last().get("ep.vv_type")).toBe(type);
      for (const name of [
        "private",
        "traffic_signals",
        "traffic_score",
        "traffic_version",
        "event",
        "ecommerce",
        "value",
      ])
        expect(last().has("ep." + name)).toBe(false);
      expect(
        (await post("generate_lead", { traffic_class: "human", traffic_phase: "initial" }, 3))
          .statusCode,
      ).toBe(204);
      expect(last().get("ep.vv_type")).toBe(type);
      expect(last().has("ep.traffic_class")).toBe(false);
      expect(
        (await post("traffic_class", { traffic_class: "robot", traffic_phase: "final" }, 4))
          .statusCode,
      ).toBe(400);
      if (denied) expect(cookie).toBeUndefined();
    });
