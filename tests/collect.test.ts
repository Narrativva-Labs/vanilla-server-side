import { afterEach, expect, it, vi } from "vitest";
import { createApp, remember } from "../src/server/app.js";
import { createTracker } from "../src/client/tracker.js";
import { buildCollectUrl } from "../src/server/google.js";
import { normalizeConsent } from "../src/shared/consent.js";
import { deviceCategory } from "../src/client/device.js";

afterEach(() => vi.useRealTimers());
const config = {
  cookieSecret: "s".repeat(64),
  measurementId: "G-TEST",
  apiSecret: "test-secret",
  siteOrigin: "https://shop.example",
};
const all = {
  analytics_storage: "granted",
  ad_storage: "granted",
  ad_user_data: "granted",
  ad_personalization: "granted",
};
const analyticsOnly = { ...all, ad_storage: "denied", ad_user_data: "denied" };
const event = (over: object = {}) => {
  const now = Date.now();
  return {
    event_id: crypto.randomUUID(),
    name: "page_view",
    client_id: "123.456",
    session_id: 123,
    session_started_ms: now,
    session_expires_ms: now + 1800000,
    timestamp_ms: now,
    consent: all,
    params: {
      page_location: "https://shop.example/landing?utm_source=news&secret=1",
      page_referrer: "https://www.google.com/",
      page_title: "Landing",
    },
    device: { language: "cs-CZ", screen_resolution: "360x800" },
    ...over,
  };
};
function setup() {
  const google = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const app = createApp(config, google);
  const post = (url: string, payload: object, cookie = "", agent = "Mozilla/5.0 Chrome/140.0") =>
    app.inject({
      method: "POST",
      url,
      headers: { origin: config.siteOrigin, cookie, "user-agent": agent },
      payload,
    });
  const urls = () => google.mock.calls.map(([url]) => new URL(String(url)));
  return { app, google, post, urls };
}

it("consent encoding matches captured Google tag hits", () => {
  const encode = (consent: object) => {
    const url = buildCollectUrl(config, {
      name: "page_view",
      clientId: "1.2",
      sessionId: 3,
      consent: normalizeConsent(consent),
      location: "https://shop.example/",
      referrer: "",
      title: "",
      sessionStart: true,
      firstVisit: false,
    }).searchParams;
    return [url.get("gcs"), url.get("gcd"), url.get("npa")];
  };
  expect(encode(all)).toEqual(["G111", "13t3t3t2t5l1", "0"]);
  expect(encode({ analytics_storage: "granted" })).toEqual(["G101", "13p3t3p2p5l1", "1"]);
  expect(encode({})).toEqual(["G100", "13p3p3p2p5l1", "1"]);
});

it("the first page_view of a session goes only through /g/collect", async () => {
  const { app, post, urls, google } = setup();
  try {
    const reply = await post("/e", event());
    expect(reply.statusCode).toBe(204);
    expect(urls().map((url) => url.pathname)).toEqual(["/g/collect"]);
    const hit = urls()[0]!.searchParams;
    expect(google.mock.calls[0]![1]!.method).toBe("POST");
    expect(google.mock.calls[0]![1]!.headers).toEqual({ "user-agent": "Mozilla/5.0 Chrome/140.0" });
    expect(hit.get("_ss")).toBe("1");
    expect(hit.get("_fv")).toBe("1");
    expect(hit.get("en")).toBe("page_view");
    expect(hit.get("tid")).toBe("G-TEST");
    expect(hit.get("ul")).toBe("cs-cz");
    expect(hit.get("sr")).toBe("360x800");
    expect(hit.get("dt")).toBe("Landing");
    expect(hit.get("dr")).toBe("https://www.google.com/");
    expect(hit.get("_uip")).toBe("127.0.0.1");
    expect(hit.get("dl")).toBe("https://shop.example/landing?utm_source=news");
    expect(String(urls()[0])).not.toContain("api_secret");

    const cookie = String(reply.headers["set-cookie"]);
    await post("/e", event(), cookie);
    expect(urls().map((url) => url.pathname)).toEqual(["/g/collect", "/mp/collect"]);
  } finally {
    await app.close();
  }
});

it("a returning visitor opens a new session without counting as a first visit", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { app, post, urls } = setup();
  try {
    const cookie = String((await post("/e", event())).headers["set-cookie"]);
    vi.setSystemTime(Date.now() + 31 * 60 * 1000);
    await post("/e", event(), cookie);
    const hit = urls()[1]!;
    expect(hit.pathname).toBe("/g/collect");
    expect(hit.searchParams.get("_ss")).toBe("1");
    expect(hit.searchParams.get("_fv")).toBeNull();
    expect(hit.searchParams.get("cid")).toBe(urls()[0]!.searchParams.get("cid"));
    expect(hit.searchParams.get("sid")).not.toBe(urls()[0]!.searchParams.get("sid"));
  } finally {
    await app.close();
  }
});

it("a session opened by another event starts through /g/collect and keeps its data in MP", async () => {
  const { app, post, urls, google } = setup();
  try {
    await post("/e", event({ name: "generate_lead" }));
    expect(urls().map((url) => url.pathname)).toEqual(["/g/collect", "/mp/collect"]);
    expect(urls()[0]!.searchParams.get("en")).toBe("page_engagement");
    const body = JSON.parse(String(google.mock.calls[1]![1]!.body));
    expect(body.events[0].name).toBe("generate_lead");
  } finally {
    await app.close();
  }
});

it("click IDs reach Google only with ad_storage and ad_user_data", async () => {
  const click_ids = { gclid: "abc123", wbraid: "w1" };
  const { app, post, urls } = setup();
  try {
    await post("/e", event({ click_ids }));
    const dl = new URL(urls()[0]!.searchParams.get("dl")!);
    expect(dl.searchParams.get("gclid")).toBe("abc123");
    expect(dl.searchParams.get("wbraid")).toBe("w1");
    expect(dl.searchParams.get("utm_source")).toBe("news");
  } finally {
    await app.close();
  }
  for (const consent of [analyticsOnly, { ...all, ad_user_data: "denied" }]) {
    // A fresh visitor, so this is the hit that would carry the click ID.
    const fresh = setup();
    try {
      await fresh.post("/e", event({ click_ids, consent }));
      expect(fresh.urls()[0]!.pathname).toBe("/g/collect");
      expect(String(fresh.urls()[0])).not.toContain("abc123");
    } finally {
      await fresh.app.close();
    }
  }
});

it("a refusal after a silent denial still names the requests on their way", async () => {
  const { tracker, sent, wait } = client();
  tracker.update(all);
  await wait(0);
  tracker.update({ analytics_storage: "denied" }, 0, true);
  tracker.update({});
  tracker.update({ analytics_storage: "denied" }, 0, true);
  await wait(0);
  const withdrawals = sent().filter((item) => item.path === "/p");
  expect(withdrawals.length).toBeGreaterThan(1);
  for (const item of withdrawals)
    expect(item.body.client_id).toBe(sent().find((hit) => hit.path === "/e")!.body.client_id);
});

it("an ad click inside a running session is kept without starting a session", async () => {
  const { app, post, urls } = setup();
  try {
    const cookie = String((await post("/e", event())).headers["set-cookie"]);
    await post("/e", event({ click_ids: { gclid: "later" } }), cookie);
    const hit = urls()[1]!;
    expect(hit.pathname).toBe("/g/collect");
    expect(hit.searchParams.get("_ss")).toBeNull();
    expect(hit.searchParams.get("dl")).toContain("gclid=later");
  } finally {
    await app.close();
  }
});

it("malformed click IDs are refused", async () => {
  const { app, post, google } = setup();
  try {
    const reply = await post("/e", event({ click_ids: { gclid: "a b" } }));
    expect(reply.statusCode).toBe(400);
    expect(google).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it("a browser that keeps no cookie does not open a session with every event", async () => {
  const { app, post, urls } = setup();
  try {
    await post("/e", event());
    await post("/e", event());
    expect(urls().map((url) => url.pathname)).toEqual(["/g/collect", "/mp/collect"]);
  } finally {
    await app.close();
  }
});

const ping = (over: object = {}) => ({
  consent: { analytics_storage: "denied", ad_storage: "denied" },
  page_location: "https://shop.example/landing?utm_source=news&gclid=abc&email=a@b.c",
  page_referrer: "https://www.google.com/",
  page_title: "Landing",
  language: "cs",
  screen_resolution: "360x800",
  ...over,
});

it("a denied ping is anonymous and leaves no cookie", async () => {
  const { app, post, urls } = setup();
  try {
    const reply = await post("/d", ping());
    expect(reply.statusCode).toBe(204);
    expect(reply.headers["set-cookie"]).toBeUndefined();
    await post("/d", ping());
    const [first, second] = urls().map((url) => url.searchParams);
    expect(urls()[0]!.pathname).toBe("/g/collect");
    expect(first!.get("gcs")).toBe("G100");
    expect(first!.get("gcd")).toBe("13p3p3p2p5l1");
    expect(first!.get("npa")).toBe("1");
    expect(first!.get("_uip")).toBeNull();
    expect(first!.get("dl")).toBe("https://shop.example/landing?utm_source=news");
    expect(first!.get("cid")).not.toBe(second!.get("cid"));
  } finally {
    await app.close();
  }
});

it("a ping ignores a visitor cookie and refuses any other consent state", async () => {
  const { app, post, urls, google } = setup();
  try {
    const reply = await post("/e", event());
    const cookie = String(reply.headers["set-cookie"]);
    await post("/d", ping(), cookie);
    expect(urls()[1]!.searchParams.get("cid")).not.toBe(urls()[0]!.searchParams.get("cid"));
    google.mockClear();
    for (const state of ["granted", "unknown"]) {
      const refused = await post("/d", ping({ consent: { analytics_storage: state } }));
      expect(refused.statusCode).toBe(400);
    }
    expect((await post("/d", ping(), "", "Googlebot/2.1")).statusCode).toBe(204);
    expect(google).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

function client(href = "https://shop.example/landing?gclid=abc&utm_source=news") {
  let now = 1_800_000_000_000;
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const tracker = createTracker(
    "https://kx7qpa.example.com/e",
    {
      now: () => now,
      uuid: () => crypto.randomUUID(),
      href: () => href,
      referrer: () => "",
      title: () => "Landing",
      warn: () => {},
      fetch: fetcher,
    },
    new Set(["generate_lead"]),
  );
  const sent = () =>
    fetcher.mock.calls.map(([url, init]) => ({
      path: new URL(String(url)).pathname,
      init: init!,
      body: JSON.parse(String(init!.body)),
    }));
  const wait = async (ms: number) => {
    now += ms;
    await tracker.flush();
  };
  return { tracker, sent, wait };
}

it("the tracker sends click IDs in their own field only with ad consent", async () => {
  const allowed = client();
  allowed.tracker.update(all);
  await allowed.wait(0);
  const body = allowed.sent().find((item) => item.path === "/e")!.body;
  expect(body.click_ids).toEqual({ gclid: "abc" });
  expect(body.params.page_location).not.toContain("gclid");
  const refused = client();
  refused.tracker.update(analyticsOnly);
  await refused.wait(0);
  expect(JSON.stringify(refused.sent().map((item) => item.body))).not.toContain("abc");
});

it("the tracker pings once per page, two seconds after the refusal, without credentials", async () => {
  const { tracker, sent, wait } = client();
  tracker.update({ analytics_storage: "denied" });
  await wait(1999);
  expect(sent()).toEqual([]);
  await wait(1);
  await wait(5000);
  expect(sent().map((item) => item.path)).toEqual(["/d"]);
  const [item] = sent();
  expect(item!.init.credentials).toBe("omit");
  expect(item!.body.page_location).toBe("https://shop.example/landing?utm_source=news");
  tracker.page();
  await wait(2000);
  expect(sent().map((item) => item.path)).toEqual(["/d", "/d"]);
});

it("a grant restored within two seconds leaves no ping behind", async () => {
  const { tracker, sent, wait } = client();
  tracker.update({ analytics_storage: "denied" });
  await wait(1000);
  tracker.update(all);
  await wait(5000);
  expect(sent().map((item) => item.path)).toEqual(["/e"]);
});

it("an undecided visitor and a withdrawal on a measured page send no ping", async () => {
  const undecided = client();
  undecided.tracker.update({});
  await undecided.wait(5000);
  expect(undecided.sent()).toEqual([]);
  const withdrawn = client();
  withdrawn.tracker.update(all);
  await withdrawn.wait(0);
  withdrawn.tracker.update({ analytics_storage: "denied" });
  await withdrawn.wait(5000);
  expect(withdrawn.sent().map((item) => item.path)).toEqual(["/e", "/p"]);
});

it("a withdrawal during session opening stops the Measurement Protocol request", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (entered = resolve));
  const paths: string[] = [];
  const google = vi.fn<typeof fetch>(async (url) => {
    const { pathname } = new URL(String(url));
    paths.push(pathname);
    if (pathname === "/g/collect") {
      entered();
      await gate;
    }
    return new Response(null, { status: 204 });
  });
  const app = createApp(config, google);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const headers = { origin: config.siteOrigin };
  try {
    const pending = app.inject({
      method: "POST",
      url: "/e",
      headers,
      payload: event({ name: "purchase" }),
    });
    await started;
    await app.inject({ method: "POST", url: "/p", headers, payload: { client_id: "123.456" } });
    release();
    const reply = await pending;
    expect(paths).toEqual(["/g/collect"]);
    expect(reply.headers["set-cookie"]).toBeUndefined();
  } finally {
    log.mockRestore();
    await app.close();
  }
});

it("a withdrawal deletes the cookie even after the rate limit is used up", async () => {
  const { app, post } = setup();
  try {
    let limited = 0;
    for (let i = 0; i < 301; i++) if ((await post("/e", event())).statusCode === 429) limited++;
    expect(limited).toBe(1);
    const reply = await post("/p", {});
    expect(reply.statusCode).toBe(204);
    expect(String(reply.headers["set-cookie"])).toContain("Max-Age=0");
  } finally {
    await app.close();
  }
});

it("a click ID in the page title reaches Google in no ping", async () => {
  const { app, post, urls } = setup();
  try {
    await post("/d", ping({ page_title: "Not found: /a?gclid=secret&x=1" }));
    expect(urls()[0]!.searchParams.get("dt")).not.toContain("secret");
  } finally {
    await app.close();
  }
  const title = client();
  title.tracker.update({ analytics_storage: "denied" });
  await title.wait(2000);
  expect(title.sent()[0]!.init.referrerPolicy).toBe("no-referrer");
});

it("a failed measurement request after an open session does not open it again", async () => {
  const google = vi.fn<typeof fetch>(
    async (url) =>
      new Response(null, { status: String(url).includes("/mp/") && !retried() ? 503 : 204 }),
  );
  let attempts = 0;
  const retried = () => attempts++ > 0;
  const app = createApp(config, google);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const headers = { origin: config.siteOrigin };
  try {
    const payload = event({ name: "purchase" });
    const first = await app.inject({ method: "POST", url: "/e", headers, payload });
    expect(first.statusCode).toBe(503);
    const cookie = String(first.headers["set-cookie"]);
    expect(cookie).toContain("vanilla_session=");
    const second = await app.inject({
      method: "POST",
      url: "/e",
      headers: { ...headers, cookie },
      payload,
    });
    expect(second.statusCode).toBe(204);
    expect(google.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/g/collect",
      "/mp/collect",
      "/mp/collect",
    ]);
  } finally {
    log.mockRestore();
    await app.close();
  }
});

function gatedApp(answer: (attempt: number) => number = () => 204) {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (entered = resolve));
  const urls: URL[] = [];
  let collects = 0;
  const google = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    if (url.pathname !== "/g/collect") return new Response(null, { status: 204 });
    collects++;
    const status = answer(collects);
    if (collects === 1) {
      entered();
      await gate;
    }
    return new Response(null, { status });
  });
  const app = createApp(config, google);
  const post = (payload = event(), path = "/e", cookie = "") =>
    app.inject({
      method: "POST",
      url: path,
      headers: { origin: config.siteOrigin, cookie },
      payload,
    });
  return { app, urls, post, started, release };
}
const moment = () => new Promise((resolve) => setTimeout(resolve, 20));

it("a parallel event waits for the opening and answers with one cookie", async () => {
  const { app, urls, post, started, release } = gatedApp();
  try {
    const first = post();
    await started;
    const second = post();
    await moment();
    expect(urls).toHaveLength(1);
    release();
    const replies = await Promise.all([first, second]);
    expect(urls.map((url) => url.pathname)).toEqual(["/g/collect", "/mp/collect"]);
    expect(urls.filter((url) => url.searchParams.get("_ss") === "1")).toHaveLength(1);
    for (const reply of replies) expect(typeof reply.headers["set-cookie"]).toBe("string");
  } finally {
    await app.close();
  }
});

it("a failed opening is taken over by the waiting event", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const { app, urls, post, started, release } = gatedApp((attempt) => (attempt === 1 ? 503 : 204));
  try {
    const first = post();
    await started;
    const second = post();
    await moment();
    release();
    await Promise.all([first, second]);
    expect(urls.map((url) => url.pathname)).toEqual(["/g/collect", "/g/collect"]);
    expect(urls[1]!.searchParams.get("_ss")).toBe("1");
  } finally {
    log.mockRestore();
    await app.close();
  }
});

it("a withdrawal during delivery leaves no renewed cookie", async () => {
  const { app, post, started, release } = gatedApp();
  try {
    const pending = post();
    await started;
    await post({ client_id: "123.456" } as never, "/p");
    release();
    expect((await pending).headers["set-cookie"]).toBeUndefined();
  } finally {
    await app.close();
  }
});

it("the same event waiting for an opening is delivered once", async () => {
  const { app, urls, post, started, release } = gatedApp();
  try {
    const first = post();
    await started;
    const payload = event({ name: "generate_lead" });
    const twins = [post(payload), post(payload)];
    await moment();
    release();
    await Promise.all([first, ...twins]);
    expect(urls.filter((url) => url.pathname === "/mp/collect")).toHaveLength(1);
  } finally {
    await app.close();
  }
});

it("a click hit that opens nothing does not confirm the session", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const { app, urls, post, started, release } = gatedApp((attempt) => (attempt <= 2 ? 503 : 204));
  try {
    const first = post();
    await started;
    const waiting = [post(), post(event({ click_ids: { gclid: "abc" } }))];
    await moment();
    release();
    await Promise.all([first, ...waiting]);
    await post();
    expect(urls.at(-1)!.pathname).toBe("/g/collect");
    expect(urls.at(-1)!.searchParams.get("_ss")).toBe("1");
  } finally {
    log.mockRestore();
    await app.close();
  }
});

it("an event waits for an opening only once", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const { app, urls, post, started, release } = gatedApp(() => 503);
  try {
    const first = post();
    await started;
    const waiting = [post(), post(), post()];
    await moment();
    release();
    await Promise.all([first, ...waiting]);
    expect(urls.length).toBeLessThanOrEqual(4);
  } finally {
    log.mockRestore();
    await app.close();
  }
});

it("a browser without cookies also gets a new session after 24 hours", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { app, post, urls } = setup();
  try {
    await post("/e", event());
    for (let minutes = 0; minutes < 24 * 60 + 1; minutes += 0.5) {
      vi.setSystemTime(Date.now() + 30_000);
      await post("/e", event());
    }
    expect(urls().filter((url) => url.searchParams.get("_ss") === "1")).toHaveLength(2);
  } finally {
    await app.close();
  }
}, 60000);

it("an invalid engagement time is not forwarded in _et", async () => {
  const { app, post, urls } = setup();
  try {
    const params = { ...event().params, engagement_time_msec: 123.5 };
    await post("/e", event({ name: "page_engagement", params }));
    expect(urls()[0]!.searchParams.get("_et")).toBeNull();
  } finally {
    await app.close();
  }
});

it("a session ends after 24 hours even with steady activity", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { app, post, urls } = setup();
  try {
    let cookie = String((await post("/e", event())).headers["set-cookie"]);
    for (let hours = 0; hours < 24; hours += 0.25) {
      vi.setSystemTime(Date.now() + 15 * 60 * 1000);
      cookie = String((await post("/e", event(), cookie)).headers["set-cookie"]);
    }
    const opened = urls().filter((url) => url.searchParams.get("_ss") === "1");
    expect(opened).toHaveLength(2);
    expect(opened[1]!.searchParams.get("_fv")).toBeNull();
  } finally {
    await app.close();
  }
});

it("engagement time survives a hit that replaces the MP request", async () => {
  const { app, post, urls } = setup();
  try {
    const params = { ...event().params, engagement_time_msec: 5000 };
    const cookie = String((await post("/e", event())).headers["set-cookie"]);
    await post("/e", event({ params, click_ids: { gclid: "later" } }), cookie);
    expect(urls()[1]!.pathname).toBe("/g/collect");
    expect(urls()[1]!.searchParams.get("_et")).toBe("5000");
  } finally {
    await app.close();
  }
});

it("a final engagement that opens a session is one hit with its time", async () => {
  const { app, post, urls } = setup();
  try {
    const params = { ...event().params, engagement_time_msec: 1200 };
    await post("/e", event({ name: "page_engagement", params }));
    expect(urls().map((url) => url.pathname)).toEqual(["/g/collect"]);
    expect(urls()[0]!.searchParams.get("_et")).toBe("1200");
  } finally {
    await app.close();
  }
});

it("events wait behind a page view that is being retried", async () => {
  let now = 1_800_000_000_000;
  const names: string[] = [];
  let failures = 1;
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    names.push(JSON.parse(String(init!.body)).name);
    return new Response(null, { status: failures-- > 0 ? 503 : 204 });
  });
  const tracker = createTracker(
    "https://kx7qpa.example.com/e",
    {
      now: () => now,
      uuid: () => crypto.randomUUID(),
      href: () => "https://shop.example/",
      referrer: () => "",
      warn: () => {},
      fetch: fetcher,
    },
    new Set(["generate_lead"]),
  );
  tracker.update(all);
  tracker.track("generate_lead");
  await tracker.flush();
  await tracker.flush();
  expect(names).toEqual(["page_view"]);
  now += 1000;
  await tracker.flush();
  await tracker.flush();
  expect(names).toEqual(["page_view", "page_view", "generate_lead"]);
});

it("visitor maps drop their oldest entry at the limit", () => {
  const map = new Map<string, number>();
  for (let i = 0; i < 5; i++) remember(map, String(i), i, 3);
  expect([...map.keys()]).toEqual(["2", "3", "4"]);
  remember(map, "4", 9, 3);
  expect(map.size).toBe(3);
});

it("DENIED_PINGS=off stops the ping in the tracker and on the server", async () => {
  const google = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  // The built server, because /s.js is served from the build output.
  const built = "../dist/server/app.js";
  const { createApp: createBuilt } = (await import(built)) as { createApp: typeof createApp };
  const app = createBuilt({ ...config, deniedPings: false }, google);
  try {
    const reply = await app.inject({
      method: "POST",
      url: "/d",
      headers: { origin: config.siteOrigin },
      payload: ping(),
    });
    expect(reply.statusCode).toBe(204);
    expect(google).not.toHaveBeenCalled();
    expect((await app.inject("/s.js")).body).toContain('dataset.pings="off"');
  } finally {
    await app.close();
  }
  let now = 1_800_000_000_000;
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const tracker = createTracker(
    "https://kx7qpa.example.com/e",
    {
      now: () => now,
      uuid: () => crypto.randomUUID(),
      href: () => "https://shop.example/",
      referrer: () => "",
      warn: () => {},
      fetch: fetcher,
    },
    new Set(),
    false,
    false,
  );
  tracker.update({ analytics_storage: "denied" });
  now += 5000;
  await tracker.flush();
  expect(fetcher).not.toHaveBeenCalled();
});

it("waiting behind a retried page view does not spin the page", async () => {
  let reads = 0;
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }));
  const tracker = createTracker(
    "https://kx7qpa.example.com/e",
    {
      now: () => {
        reads++;
        return 1_800_000_000_000;
      },
      uuid: () => crypto.randomUUID(),
      href: () => "https://shop.example/",
      referrer: () => "",
      warn: () => {},
      fetch: fetcher,
    },
    new Set(["generate_lead"]),
  );
  tracker.update(all);
  tracker.track("generate_lead");
  await tracker.flush();
  const before = reads;
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(reads - before).toBeLessThan(20);
});

it("a restored page reads consent before it sends the page view", async () => {
  const refused = client();
  refused.tracker.update(all);
  await refused.wait(0);
  refused.tracker.page(() => refused.tracker.update({ analytics_storage: "denied" }));
  await refused.wait(0);
  expect(refused.sent().filter((item) => item.path === "/e")).toHaveLength(1);
  const granted = client();
  granted.tracker.update({ analytics_storage: "denied" });
  await granted.wait(0);
  granted.tracker.page(() => granted.tracker.update(all));
  await granted.wait(0);
  expect(granted.sent().filter((item) => item.path === "/e")).toHaveLength(1);
});

it("the server cleans URLs itself, for a request that skipped the tracker", async () => {
  const { app, post, google } = setup();
  try {
    const page_location = "https://alice:password@shop.example/a?token=PRIVATE&utm_source=x#frag";
    await post("/e", event({ name: "generate_lead", params: { page_location } }));
    const body = String(google.mock.calls[1]![1]!.body);
    for (const secret of ["alice", "password", "PRIVATE", "frag"])
      expect(body).not.toContain(secret);
    expect(body).toContain("utm_source=x");
  } finally {
    await app.close();
  }
});

it("a withdrawal that overtakes the first event still stops it", async () => {
  const { app, post, urls } = setup();
  try {
    await post("/p", { client_id: "123.456" });
    const reply = await post("/e", event());
    expect(urls()).toEqual([]);
    expect(reply.headers["set-cookie"]).toBeUndefined();
  } finally {
    await app.close();
  }
});

it("device categories include tablets", () => {
  const android = "Mozilla/5.0 (Linux; Android 14; SM-X710) Chrome/140.0 Safari/537.36";
  expect(deviceCategory(android)).toBe("tablet");
  expect(deviceCategory(android.replace("Safari", "Mobile Safari"))).toBe("mobile");
  expect(deviceCategory("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)")).toBe("tablet");
  expect(deviceCategory("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile/15E148")).toBe("mobile");
  expect(deviceCategory("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("desktop");
  expect(deviceCategory("Mozilla/5.0 (Windows NT 10.0; Tablet PC 2.0)")).toBe("desktop");
  expect(deviceCategory("Mozilla/5.0 (Linux; Android 12; BRAVIA 4K GB ATV3)")).not.toBe("tablet");
});

it("a measured visitor who goes through unknown to denied is withdrawn", async () => {
  const { tracker, sent, wait } = client();
  tracker.update(all);
  await wait(0);
  tracker.update({});
  tracker.update({ analytics_storage: "denied" });
  await wait(0);
  expect(sent().map((item) => item.path)).toEqual(["/e", "/p"]);
});

it("leaving a page after an expired session sends nothing for the old page", async () => {
  const { tracker, sent, wait } = client();
  tracker.update(all);
  await wait(0);
  await wait(31 * 60 * 1000);
  tracker.leave("https://shop.example/old");
  await wait(0);
  expect(sent().filter((item) => item.body.name === "page_engagement")).toEqual([]);
  tracker.page();
  await wait(0);
  const view = sent()
    .filter((item) => item.body.name === "page_view")
    .at(-1)!;
  expect(view.body.params.engagement_time_msec).toBeLessThan(5000);
});
