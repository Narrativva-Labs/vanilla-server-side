import { afterEach, expect, it, vi } from "vitest";
import { createApp, remember } from "../src/server/app.js";
import { createTracker } from "../src/client/tracker.js";
import { buildCollectUrl } from "../src/server/google.js";
import { normalizeConsent } from "../src/shared/consent.js";

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
    await post("/e", event({ name: "page_engagement" }));
    expect(urls().map((url) => url.pathname)).toEqual(["/g/collect", "/mp/collect"]);
    expect(urls()[0]!.searchParams.get("en")).toBe("page_engagement");
    const body = JSON.parse(String(google.mock.calls[1]![1]!.body));
    expect(body.events[0].name).toBe("page_engagement");
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
    await post("/e", event({ click_ids, consent: analyticsOnly }));
    expect(String(urls()[1])).not.toContain("abc123");
    await post("/e", event({ click_ids, consent: { ...all, ad_user_data: "denied" } }));
    expect(String(urls()[2])).not.toContain("abc123");
  } finally {
    await app.close();
  }
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

it("parallel events open a session once and answer with one cookie", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (entered = resolve));
  const urls: URL[] = [];
  const google = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    if (url.pathname === "/g/collect") {
      entered();
      await gate;
    }
    return new Response(null, { status: 204 });
  });
  const app = createApp(config, google);
  const post = () =>
    app.inject({
      method: "POST",
      url: "/e",
      headers: { origin: config.siteOrigin },
      payload: event(),
    });
  try {
    const first = post();
    await started;
    const second = await post();
    release();
    const replies = [await first, second];
    expect(urls.map((url) => url.pathname)).toEqual(["/g/collect", "/mp/collect"]);
    expect(urls.filter((url) => url.searchParams.get("_ss") === "1")).toHaveLength(1);
    for (const reply of replies) expect(typeof reply.headers["set-cookie"]).toBe("string");
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
