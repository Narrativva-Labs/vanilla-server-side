import { afterEach, expect, it, vi } from "vitest";
import { page } from "./browser-fixture.js";
import { createApp } from "../src/server/app.js";
import { trafficUpdateFields } from "../src/shared/traffic.js";
import { createTracker } from "../src/client/tracker.js";

const settle = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
const context = {
  page_location: "https://shop.example/?utm_source=test",
  page_title: "Shop",
  page_referrer: "",
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
  it(`sends independent whitelisted final and agent keepalive updates while hidden with ${consent} consent`, async () => {
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
    expect(updates).toHaveLength(2);
    expect(updates[0]!.body.params).toEqual({
      ...context,
      traffic_class: "suspicious",
      traffic_phase: "final",
    });
    expect(updates[1]!.body.params).toEqual({
      ...context,
      traffic_class: "declared_agent",
      traffic_phase: "agent",
      traffic_agent: "openai",
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
    ).toHaveLength(2);
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
  ).toEqual([
    {
      ...context,
      traffic_class: "declared_agent",
      traffic_phase: "agent",
      traffic_agent: "openai",
    },
    { ...context, traffic_class: "suspicious", traffic_phase: "final" },
  ]);
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
  ).toEqual([{ ...context, traffic_class: "suspicious", traffic_phase: "final" }]);
  expect(hits(p, "/e").map(({ body }) => body.name)).toEqual(["page_view", "traffic_class"]);
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

it("the update waits for the first response and never retries its best-effort request", async () => {
  let respond!: (response: Response) => void;
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
        if (body.name === "page_view")
          return new Promise<Response>((resolve) => {
            respond = resolve;
          });
        throw Error("offline");
      }),
    },
    new Set(),
  );
  tracker.update({ analytics_storage: "granted" });
  tracker.track("traffic_class", publication());
  tracker.track("traffic_class", publication());
  await tracker.flush();
  expect(requests.map((r) => r.name)).toEqual(["page_view"]);
  respond(new Response(null, { status: 204 }));
  await settle();
  expect(requests.map((r) => r.name)).toEqual(["page_view", "traffic_class"]);
  await tracker.flush();
  expect(requests).toHaveLength(2);
});

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
for (const denied of [false, true])
  for (const [value, phase, type, replay] of [
    ["suspicious", "final", "bot_suspicious"],
    ["suspicious", "final", "bot_suspicious", "late"],
    ["suspicious", "final", "bot_suspicious", "invalid"],
    ["declared_agent", "agent", "agent_unverified"],
  ])
    it(`forwards the dedicated event and updates ${denied ? "page" : "session"} memory for ${value}/${replay ?? "original"} with a server whitelist`, async () => {
      const google = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
      const app = createApp(
        {
          cookieSecret: "s".repeat(64),
          measurementId: "G-TEST",
          siteOrigin: "https://shop.example",
          allowedEvents: ["generate_lead", "add_to_cart", "begin_checkout"],
        },
        google,
      );
      apps.push(app);
      let cookie: string | undefined;
      const now = Date.now();
      const post = async (name: string, params: unknown, hit_index = 1) => {
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
            {
              ...publication(value, phase),
              traffic_replay: replay,
              vv_type: "agent_verified",
              page_location:
                "https://shop.example/product?email=private&gclid=secret&utm_source=test#secret",
              page_title: "Product",
              page_referrer: "https://ref.example/?token=secret",
            },
            2,
          )
        ).statusCode,
      ).toBe(204);
      const last = () => {
        const [url, init] = google.mock.calls.at(-1)!;
        return new URLSearchParams(new URL(String(url)).search + "&" + String(init?.body ?? ""));
      };
      expect(last().get("en")).toBe("traffic_class");
      expect(last().get("dl")).toBe("https://shop.example/product?utm_source=test");
      expect(last().get("dt")).toBe("Product");
      expect(last().get("dr")).toBe("https://ref.example/");
      expect(last().get("ep.traffic_class")).toBe(value);
      expect(last().get("ep.traffic_phase")).toBe(phase);
      expect(last().get("ep.traffic_agent")).toBe(value === "declared_agent" ? "openai" : null);
      expect(last().get("ep.traffic_replay")).toBe(replay === "late" ? "late" : null);
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
        (
          await post(
            "generate_lead",
            { traffic_class: "human", traffic_phase: "initial", traffic_replay: "invalid" },
            3,
          )
        ).statusCode,
      ).toBe(204);
      expect(last().get("ep.vv_type")).toBe(type);
      expect(last().has("ep.traffic_class")).toBe(false);
      expect(last().has("ep.traffic_replay")).toBe(false);
      expect(
        (await post("traffic_class", { traffic_class: "robot", traffic_phase: "final" }, 4))
          .statusCode,
      ).toBe(400);
      for (const params of [undefined, null, [], "invalid", 1, true])
        expect((await post("traffic_class", params, 5)).statusCode).toBe(400);
      for (const [index, name] of ["add_to_cart", "begin_checkout"].entries()) {
        expect((await post(name, {}, 6 + index)).statusCode).toBe(204);
        expect(last().get("ep.vv_type")).toBe(type);
      }
      if (denied) expect(cookie).toBeUndefined();
    });

for (const consent of ["granted", "denied"]) {
  for (const [initial, final, count] of [
    ["human", "human", 0],
    ["suspicious", "human", 1],
    ["suspicious", "suspicious", 1],
    ["human", "automated", 1],
  ] as const)
    it(`final ${initial} to ${final} with ${consent} sends ${count} update`, async () => {
      const p = page([], {
        setup(host) {
          host.__visitorVerdict = Object.freeze({ class: initial, phase: "initial" });
        },
      });
      p.command("consent", "update", { analytics_storage: consent });
      await settle();
      p.host.dataLayer.push(publication(final));
      await settle();
      expect(
        hits(p, consent === "granted" ? "/e" : "/d").filter(
          ({ body }) => body.name === "traffic_class",
        ),
      ).toHaveLength(count);
      p.host.dataLayer.push(publication("declared_agent", "agent"));
      await settle();
      expect(
        hits(p, consent === "granted" ? "/e" : "/d").filter(
          ({ body }) => body.name === "traffic_class",
        ),
      ).toHaveLength(count + 1);
    });
}
it("retries a phase after denied pings were disabled, and sends later agent after grant", async () => {
  const p = page([], { dataset: { pings: "off" } });
  p.command("consent", "update", { analytics_storage: "denied" });
  p.host.dataLayer.push(publication());
  await settle();
  p.command("consent", "update", { analytics_storage: "granted" });
  await settle();
  p.host.dataLayer.push(publication(), publication("declared_agent", "agent"));
  await settle();
  expect(hits(p, "/e").map(({ body }) => body.name)).toEqual([
    "page_view",
    "traffic_class",
    "traffic_class",
  ]);
});
it("drops an expired waiting phase without consuming it or the agent phase", async () => {
  let now = Date.now();
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const tracker = createTracker(
    "https://tracker.example/e",
    {
      href: () => "https://shop.example/",
      referrer: () => "",
      now: () => now,
      uuid: () => crypto.randomUUID(),
      warn: vi.fn(),
      fetch: fetcher,
    },
    new Set(),
    false,
    false,
  );
  tracker.track("traffic_class", publication());
  now += 73 * 60 * 60 * 1000;
  tracker.update({ analytics_storage: "granted" });
  await settle();
  expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).name)).toEqual([
    "page_view",
  ]);
  tracker.track("traffic_class", publication());
  tracker.track("traffic_class", publication("declared_agent", "agent"));
  await settle();
  expect(tracker.pending()).toBe(0);
  expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).name)).toEqual([
    "page_view",
    "traffic_class",
    "traffic_class",
  ]);
});
it("supports a custom array-like layer selected on s.js before late detector config", async () => {
  const custom = { length: 0, push: Array.prototype.push };
  const p = page([], {
    dataset: { vvLayer: "verdicts" },
    setup(host) {
      host.verdicts = custom;
    },
  });
  (p.host as unknown as Record<string, unknown>).visitorVerdictConfig = {
    dataLayerName: "verdicts",
  };
  p.command("consent", "update", { analytics_storage: "granted" });
  await settle();
  custom.push(publication());
  await settle();
  expect(custom.length).toBe(1);
  expect(hits(p, "/e").filter(({ body }) => body.name === "traffic_class")).toHaveLength(1);
});

it("keeps a pending update behind session bootstrap and reuses the resulting cookie", async () => {
  const google = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const app = createApp(
    { cookieSecret: "s".repeat(64), measurementId: "G-TEST", siteOrigin: "https://shop.example" },
    google,
  );
  apps.push(app);
  let cookie = "";
  let respond!: () => void;
  const requests: { name: string; cookie: string; bootstrap_token: string; hit_index: number }[] =
    [];
  const tracker = createTracker(
    "https://tracker.example/e",
    {
      href: () => "https://shop.example/",
      referrer: () => "",
      now: Date.now,
      uuid: () => crypto.randomUUID(),
      warn: vi.fn(),
      traffic: () => ({ traffic_class: "human", traffic_phase: "initial" }),
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push({ ...body, cookie });
        if (body.name === "page_view" && requests.length === 1)
          await new Promise<void>((resolve) => {
            respond = resolve;
          });
        const response = await app.inject({
          method: "POST",
          url: "/e",
          headers: {
            origin: "https://shop.example",
            "user-agent": "Chrome/140.0",
            ...(cookie ? { cookie } : {}),
          },
          payload: body,
        });
        expect(response.statusCode).toBe(204);
        if (response.headers["set-cookie"])
          cookie = String(response.headers["set-cookie"]).split(";")[0]!;
        return new Response(null, { status: response.statusCode });
      },
    },
    new Set(),
    true,
  );
  tracker.update({ analytics_storage: "granted" });
  tracker.track("traffic_class", publication());
  tracker.start();
  await settle();
  expect(requests.map((r) => r.name)).toEqual(["page_view"]);
  respond();
  await vi.waitFor(() => expect(google).toHaveBeenCalledTimes(2));
  expect(requests.map((r) => r.name)).toEqual(["page_view", "traffic_class"]);
  expect(requests[1]!.cookie).toMatch(/^vanilla_session=/);
  expect(requests[1]!.bootstrap_token).toBe(requests[0]!.bootstrap_token);
  expect(requests.map((r) => r.hit_index)).toEqual([1, 2]);
  tracker.page();
  await vi.waitFor(() => expect(google).toHaveBeenCalledTimes(3));
  const [url, init] = google.mock.calls[2]!;
  const sent = new URLSearchParams(new URL(String(url)).search + "&" + String(init?.body ?? ""));
  expect(sent.get("ep.vv_type")).toBe("bot_suspicious");
});

it("applies withdrawal before dispatching an update queued behind a slow first request", async () => {
  let respond!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>((_url, init) => {
    const body = JSON.parse(String(init?.body));
    return body.name === "page_view"
      ? new Promise((resolve) => {
          respond = resolve;
        })
      : Promise.resolve(new Response(null, { status: 204 }));
  });
  const tracker = createTracker(
    "https://tracker.example/e",
    {
      href: () => "https://shop.example/",
      referrer: () => "",
      now: Date.now,
      uuid: () => crypto.randomUUID(),
      warn: vi.fn(),
      fetch: fetcher,
    },
    new Set(),
    false,
    false,
  );
  tracker.update({ analytics_storage: "granted" });
  tracker.track("traffic_class", publication());
  tracker.update({ analytics_storage: "denied" });
  respond(new Response(null, { status: 204 }));
  await settle();
  expect(
    fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).name).filter(Boolean),
  ).toEqual(["page_view"]);
});

it("rejects non-object dedicated update params without throwing", () => {
  for (const params of [null, undefined, [], "human", 1, true])
    expect(trafficUpdateFields(params)).toBeUndefined();
});

const late = (value = "suspicious") => ({ ...publication(value), traffic_replay: "late" });
for (const consent of ["granted", "denied"])
  for (const waiting of [false, true])
    it(`accepts one late escalation with ${consent} consent, waiting=${waiting}, and retains it on ecommerce`, async () => {
      const p = page([], {
        setup(host) {
          host.__visitorVerdict = Object.freeze({ class: "human", phase: "initial" });
        },
      });
      if (!waiting) {
        p.command("consent", "update", { analytics_storage: consent });
        await settle();
      }
      p.host.dataLayer.push(publication("human"));
      p.host.dataLayer.push({ ...publication("human"), traffic_replay: "consent" });
      p.host.dataLayer.push(late(), late());
      p.host.dataLayer.push({ ...late(), traffic_replay: "consent" });
      if (waiting) p.command("consent", "update", { analytics_storage: consent });
      await settle();
      p.host.dataLayer.push({ event: "add_to_cart", ecommerce: { value: 10, currency: "CZK" } });
      p.host.dataLayer.push({ event: "begin_checkout" });
      p.host.history.pushState({}, "", "https://shop.example/next");
      p.host.dataLayer.push(late());
      p.host.dispatchEvent(new Event("pagehide"));
      await settle();
      const sent = hits(p, consent === "granted" ? "/e" : "/d");
      const updates = sent.filter(({ body }) => body.name === "traffic_class");
      expect(updates.filter(({ body }) => body.params.traffic_replay === "late")).toHaveLength(1);
      expect(updates.filter(({ body }) => body.params.traffic_replay === "consent")).toHaveLength(
        0,
      );
      for (const name of ["add_to_cart", "begin_checkout"])
        expect(sent.find(({ body }) => body.name === name)?.body.params).toMatchObject({
          traffic_class: "suspicious",
          traffic_phase: "final",
        });
    });

for (const previous of ["human", "suspicious", "automated", "declared_agent"])
  for (const waiting of [false, true])
    it(`rejects late same/lower classes after ${previous}, waiting=${waiting}`, async () => {
      const p = page([], {
        setup(host) {
          host.__visitorVerdict = Object.freeze({
            class: previous,
            phase: "final",
            agent: "openai",
          });
        },
      });
      if (!waiting) {
        p.command("consent", "update", { analytics_storage: "granted" });
        await settle();
      }
      p.host.dataLayer.push(
        publication(previous, previous === "declared_agent" ? "agent" : "final"),
      );
      p.host.dataLayer.push(late("human"), late("automated"), late("declared_agent"));
      if (previous !== "human") p.host.dataLayer.push(late());
      if (waiting) p.command("consent", "update", { analytics_storage: "granted" });
      await settle();
      expect(
        hits(p, "/e").filter(({ body }) => body.params.traffic_replay === "late"),
      ).toHaveLength(0);
    });

it("drops unknown replay values and accepts only final suspicious late publications", () => {
  expect(trafficUpdateFields({ ...publication(), traffic_replay: "arbitrary" })).not.toHaveProperty(
    "traffic_replay",
  );
  expect(trafficUpdateFields({ ...publication(), traffic_replay: "consent" })).toHaveProperty(
    "traffic_replay",
    "consent",
  );
  expect(trafficUpdateFields({ ...late(), traffic_phase: "agent" })).toBeUndefined();
});

it("deduplicates late publications queued behind a slow first consented request", async () => {
  let respond!: (response: Response) => void;
  const requests: { name: string; params: Record<string, unknown> }[] = [];
  const tracker = createTracker(
    "https://tracker.example/e",
    {
      href: () => "https://shop.example/",
      referrer: () => "",
      now: Date.now,
      uuid: () => crypto.randomUUID(),
      warn: vi.fn(),
      traffic: () => ({ traffic_class: "human", traffic_phase: "initial" }),
      fetch: vi.fn<typeof fetch>((_url, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        return body.name === "page_view"
          ? new Promise((resolve) => {
              respond = resolve;
            })
          : Promise.resolve(new Response(null, { status: 204 }));
      }),
    },
    new Set(["add_to_cart"]),
  );
  tracker.update({ analytics_storage: "granted" });
  tracker.track("traffic_class", publication("human"));
  tracker.track("traffic_class", late());
  tracker.track("traffic_class", late());
  tracker.track("add_to_cart");
  respond(new Response(null, { status: 204 }));
  await settle();
  expect(requests.filter((hit) => hit.params.traffic_replay === "late")).toHaveLength(1);
  expect(requests.find((hit) => hit.name === "add_to_cart")?.params.traffic_class).toBe(
    "suspicious",
  );
});

it("accepts the late event after its updated frozen snapshot, while preserving stronger future classes", async () => {
  const p = page([], {
    setup(host) {
      host.__visitorVerdict = Object.freeze({ class: "human", phase: "initial" });
    },
  });
  p.command("consent", "update", { analytics_storage: "granted" });
  await settle();
  const host = p.host as unknown as Record<string, unknown>;
  host.__visitorVerdict = Object.freeze({ class: "suspicious", phase: "final" });
  p.host.dataLayer.push(late(), { event: "add_to_cart" });
  await settle();
  expect(hits(p, "/e").filter(({ body }) => body.params.traffic_replay === "late")).toHaveLength(1);
  expect(
    hits(p, "/e").find(({ body }) => body.name === "add_to_cart")?.body.params.traffic_class,
  ).toBe("suspicious");
  host.__visitorVerdict = Object.freeze({
    class: "declared_agent",
    phase: "agent",
    agent: "openai",
  });
  p.host.dataLayer.push({ event: "begin_checkout" });
  await settle();
  expect(
    hits(p, "/e").find(({ body }) => body.name === "begin_checkout")?.body.params,
  ).toMatchObject({
    traffic_class: "declared_agent",
    traffic_agent: "openai",
  });
});

for (const consent of ["granted", "denied"])
  it(`sends late final independently after an already delivered human final with ${consent} consent`, async () => {
    const p = page();
    p.command("consent", "update", { analytics_storage: consent });
    await settle();
    p.host.dataLayer.push(publication("human"));
    await settle();
    const path = consent === "granted" ? "/e" : "/d";
    expect(hits(p, path).filter(({ body }) => body.name === "traffic_class")).toHaveLength(1);
    p.host.dataLayer.push(late(), late());
    await settle();
    const updates = hits(p, path).filter(({ body }) => body.name === "traffic_class");
    expect(updates.map(({ body }) => body.params.traffic_class)).toEqual(["human", "suspicious"]);
    expect(updates[1]!.body.params.traffic_replay).toBe("late");
  });
