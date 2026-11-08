/**
 * Random sequences against the real tracker and collector, with a fake Google that fails and
 * stalls. The checks are rules that must hold in every order, not expected examples.
 * More runs: FUZZ_RUNS=20000 npx vitest run tests/fuzz.test.ts. One run: FUZZ_SEED=123.
 */
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { createTracker } from "../src/client/tracker.js";

const SECRET = "CLICKSECRET";
const RUNS = Number(process.env.FUZZ_RUNS ?? 300);
const START = Number(process.env.FUZZ_SEED ?? 1);
const config = {
  cookieSecret: "s".repeat(64),
  measurementId: "G-FUZZ",

  siteOrigin: "https://shop.example",
};
const consents = [
  { analytics_storage: "granted", ad_storage: "granted", ad_user_data: "granted" },
  { analytics_storage: "granted", ad_storage: "denied", ad_user_data: "denied" },
  { analytics_storage: "granted", ad_storage: "granted", ad_user_data: "denied" },
  { analytics_storage: "denied", ad_storage: "denied", ad_user_data: "denied" },
  { analytics_storage: "denied", ad_storage: "granted", ad_user_data: "granted" },
  {},
];
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
interface Hit {
  path: string;
  cid: string;
  sid: string;
  ip?: string;
  query: URLSearchParams;
  ok: boolean;
  raw: string;
  time: number;
}
async function scenario(seed: number) {
  const rand = random(seed);
  const pick = <T>(items: readonly T[]) => items[Math.floor(rand() * items.length)]!;
  const flaky = rand() < 0.7;
  const problems: string[] = [];
  const trace = (text: string) => {
    if (process.env.FUZZ_TRACE) process.stderr.write(`${Date.now() % 10000000} ${text}\n`);
  };
  const problem = (text: string) => {
    trace(`!!! ${text}`);
    problems.push(`${text} (seed ${seed})`);
  };
  const hits: Hit[] = [];
  const ip = "192.0.2.10";
  let calm = false;
  // Requests started after the withdrawal, before any new event: must not reach Google.
  let quiet = false;
  const google: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const raw = url.href + String(init?.body ?? "");
    if (url.pathname !== "/g/collect") problem("unexpected upstream endpoint");
    const query = url.searchParams;
    const measured = query.get("gcs")?.[3] === "1";
    if (quiet && measured) problem(`measured hit ${url.pathname} after withdrawal`);
    trace(
      `GOOGLE> ${url.pathname} en=${query.get("en")} ss=${query.get("_ss")} sid=${query.get("sid")} cid=${query.get("cid")}`,
    );
    for (let i = Math.floor(rand() * 4); i > 0; i--) await turn();
    const roll = flaky && !calm ? rand() : 1;
    if (roll < 0.04) throw new Error("network");
    const status = roll < 0.12 ? 503 : roll < 0.14 ? 429 : roll < 0.16 ? 400 : 204;
    trace(`GOOGLE< ${url.pathname} ${status}`);
    hits.push({
      path: url.pathname,
      cid: query.get("cid") ?? "",
      sid: String(query.get("sid")),
      ip: query.get("_uip") ?? undefined,
      query,
      ok: status === 204,
      raw,
      time: Date.now(),
    });
    return new Response(null, { status });
  };
  const app = createApp(config, google);
  let cookie = "";
  let withdrawnAt = 0;
  let withdrawals = 0;
  let started = 0;
  let lastEvent = 0;
  let decided = false;
  let open = 0;
  const transport: typeof fetch = async (input, init) => {
    const { pathname } = new URL(String(input));
    const payload = JSON.parse(String(init?.body ?? "{}"));
    const order = ++started;
    if (pathname === "/p") withdrawals++;
    trace(
      `SEND ${pathname} ${payload.name ?? ""} id=${payload.client_id} cookie=${cookie ? "yes" : "no"}`,
    );
    if (pathname === "/e") {
      quiet = false;
      lastEvent = order;
      if (payload.consent?.analytics_storage !== "granted") problem("event without analytics");
      const allowed =
        payload.consent?.ad_storage === "granted" && payload.consent?.ad_user_data === "granted";
      if (payload.click_ids && !allowed) problem("click ID without both ad consents");
    }
    if (pathname === "/d" && JSON.stringify(payload).includes(SECRET))
      problem("click ID in a ping request");
    open++;
    try {
      // The network can deliver requests out of order, a withdrawal before an earlier event.
      for (let i = rand() < 0.3 ? 1 + Math.floor(rand() * 5) : 0; i > 0; i--) await turn();
      const reply = await app.inject({
        method: "POST",
        url: pathname,
        remoteAddress: ip,
        headers: {
          origin: config.siteOrigin,
          "content-type": "application/json",
          "user-agent": "Mozilla/5.0 Chrome/140.0",
          ...(cookie && init?.credentials !== "omit" ? { cookie } : {}),
        },
        payload,
      });
      trace(
        `REPLY ${pathname} ${payload.name ?? ""} ${reply.statusCode} cookie=${reply.headers["set-cookie"] ? "yes" : "no"} aborted=${init?.signal?.aborted}`,
      );
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      const header = reply.headers["set-cookie"];
      if (Array.isArray(header)) problem("two Set-Cookie headers");
      if (pathname === "/d" && header) problem("cookie from a ping");
      if (pathname === "/p") {
        cookie = "";
        // Only once every withdrawal has arrived: until then the server cannot know.
        withdrawals--;
        quiet = withdrawals === 0 && lastEvent < order;
        if (withdrawals === 0) withdrawnAt = order;
      } else if (header) {
        if (order < withdrawnAt) problem("cookie restored after withdrawal");
        else cookie = String(header).split(";")[0]!;
      }
      return new Response(null, { status: reply.statusCode });
    } finally {
      open--;
    }
  };
  let href = "https://shop.example/";
  let reads = 0;
  const tracker = createTracker(
    "https://kx7qpa.example.com/e",
    {
      now() {
        if (++reads > 200_000) throw new Error(`page blocked (seed ${seed})`);
        return Date.now();
      },
      uuid: () => crypto.randomUUID(),
      href: () => href,
      referrer: () => "",
      title: () => pick(["Shop", `Not found /x?gclid=${SECRET}`]),
      engagement: () => Math.floor(rand() * 3000),
      device: () => ({ language: "cs", screen_resolution: "360x800" }),
      warn: () => {},
      fetch: transport,
    },
    new Set(["generate_lead", "purchase"]),
  );
  const steps = 10 + Math.floor(rand() * 50);
  for (let step = 0; step < steps; step++) {
    const roll = rand();
    trace(`STEP ${step} roll=${roll.toFixed(2)} pending=${tracker.pending()}`);
    if (roll < 0.25) {
      const next = pick(consents);
      trace(`CONSENT ${JSON.stringify(next)}`);
      decided = "analytics_storage" in next;
      tracker.update(next, 0, rand() < 0.3);
    } else if (roll < 0.45) tracker.track("generate_lead");
    else if (roll < 0.55) tracker.track("purchase", { transaction_id: String(step) });
    else if (roll < 0.7) {
      href = `https://shop.example/p${step}${rand() < 0.4 ? `?gclid=${SECRET}${step}` : ""}`;
      tracker.page();
    } else if (roll < 0.78) tracker.exit(1000);
    else if (roll < 0.95) vi.setSystemTime(Date.now() + 100 + Math.floor(rand() * 3000));
    // Long gaps only between requests: no request stays open for half an hour.
    else if (open === 0)
      vi.setSystemTime(Date.now() + pick([20 * 60_000, 31 * 60_000, 25 * 3_600_000]));
    if (rand() < 0.6) void tracker.flush();
    for (let i = Math.floor(rand() * 4); i > 0; i--) {
      reads = 0;
      await turn();
    }
  }
  calm = true;
  for (let i = 0; i < 40 && (open > 0 || tracker.pending() > 0); i++) {
    vi.setSystemTime(Date.now() + 1100);
    void tracker.flush();
    for (let j = 0; j < 8; j++) {
      reads = 0;
      await turn();
    }
  }
  if (open > 0) problem("a request never finished");
  if (decided && tracker.pending() > 0) problem("events stuck in the queue");
  await app.close();

  const delivered = hits.filter((hit) => hit.ok);
  const opened = new Map<string, number>();
  const openedAt = new Map<string, number>();
  const firstVisits = new Map<string, number>();
  const purchases = new Map<string, number>();
  for (const hit of delivered) {
    const key = `${hit.cid}/${hit.sid}`;
    const pinged = hit.query.get("gcs")?.[3] === "0";
    if (pinged) {
      if (hit.ip) problem("visitor IP in a ping");
      if (hit.raw.includes(SECRET)) problem("click ID in a ping");
      continue;
    }
    if (hit.ip !== ip) problem(`wrong or missing IP ${hit.path}`);
    if (hit.path === "/g/collect") {
      const clicked = hit.query.get("dl")?.includes("gclid=");
      const gcd = hit.query.get("gcd") ?? "";
      const allowed = hit.query.get("gcs")?.[2] === "1" && gcd[6] === "t";
      if (clicked && !allowed) problem("click ID at Google without both ad consents");
      if (hit.query.get("dt")?.includes(SECRET)) problem("click ID in a title");
      if (hit.query.get("_ss") === "1") opened.set(key, (opened.get(key) ?? 0) + 1);
      if (hit.query.get("_fv") === "1")
        firstVisits.set(hit.cid, (firstVisits.get(hit.cid) ?? 0) + 1);
    }
    if (!opened.has(key)) problem(`hit before its session opened ${hit.path}`);
    if (!openedAt.has(key)) openedAt.set(key, hit.time);
    // Two minutes over: an event already in the queue keeps its session.
    if (hit.time - openedAt.get(key)! > 24 * 3_600_000 + 120_000)
      problem("session longer than 24 hours");
    if (hit.query.get("en") === "purchase") {
      const id = hit.query.get("ep.transaction_id") ?? "";
      purchases.set(id, (purchases.get(id) ?? 0) + 1);
    }
  }
  for (const [key, count] of opened)
    if (count > 1) problem(`session opened ${count} times: ${key}`);
  for (const [id, count] of purchases) if (count > 1) problem(`purchase ${count} times: ${id}`);
  for (const [cid, count] of firstVisits)
    if (count > 1) problem(`first visit ${count} times: ${cid}`);
  return problems;
}

afterEach(() => vi.useRealTimers());
it(`rules hold over ${RUNS} random runs`, async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const found = new Map<string, string>();
  for (let seed = START; seed < START + RUNS; seed++)
    for (const text of await scenario(seed)) {
      const rule = text.replace(/ \(seed \d+\)$/, "").replace(/\d[\d./]*/g, "#");
      if (!found.has(rule)) found.set(rule, text);
    }
  log.mockRestore();
  expect([...found.values()]).toEqual([]);
}, 600000);
