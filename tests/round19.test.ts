import { expect, it } from "vitest";
import { createLabelMemory } from "../src/server/labels.js";
import { createApp } from "../src/server/app.js";
const human = { vv_type: "human" as const, vv_detail: "none|-|-|-|human|final" };
const proof = { vv_type: "agent_verified" as const, vv_detail: "openai|-|-|-|human|final" };
it("capacity churn does not scan live entries and expired evidence is evicted first", () => {
  let now = 0;
  const m = createLabelMemory(3, 100, () => now);
  m.apply("live", proof, true, 100);
  m.apply("short", proof, true, 5);
  m.apply("other", human);
  const original = Map.prototype[Symbol.iterator];
  Map.prototype[Symbol.iterator] = function () {
    throw new Error("full map scan");
  };
  try {
    now = 10;
    m.apply("new", human);
    expect(m.apply("live", human).vv_type).toBe("agent_verified");
    for (let i = 0; i < 100; i++) m.apply(String(i), human);
    expect(m.size).toBe(3);
  } finally {
    Map.prototype[Symbol.iterator] = original;
  }
});
it("same evidence never shortens expiry; another operator gets only its own proof lifetime", () => {
  let now = 0;
  const m = createLabelMemory(10, 100, () => now);
  m.apply("s", proof, true, 100);
  now = 10;
  m.apply("s", proof, true, 15);
  now = 16;
  expect(m.apply("s", human).vv_type).toBe("agent_verified");
  const other = { ...proof, vv_detail: "anthropic|-|-|-|human|final" };
  m.apply("s", other, true, 20);
  now = 21;
  expect(m.apply("s", human)).toEqual(human);
  now = 100;
  const bot = { ...human, vv_type: "bot_automation" as const };
  m.apply("b", bot);
  now = 90;
  m.apply("b", bot);
  now = 195;
  expect(m.apply("b", human).vv_type).toBe("bot_automation");
});
it("invalid clocks and nonpositive lifetimes cannot retain labels", () => {
  for (const clock of [NaN, Infinity, -Infinity]) {
    const m = createLabelMemory(2, 100, () => clock);
    m.apply("s", human);
    expect(m.size).toBe(0);
  }
  for (const ttl of [0, -1]) {
    const m = createLabelMemory(2, ttl, () => 0);
    m.apply("s", human);
    expect(m.size).toBe(0);
  }
});
it("programmatic proxy settings validate before Fastify and empty arrays disable trust", async () => {
  const config = {
    measurementId: "G-TEST",
    cookieSecret: "s".repeat(64),
    siteOrigin: "https://example.com",
  };
  expect(() => createApp({ ...config, trustProxy: ["10.0.0.0/33"] })).toThrow(/TRUST_PROXY/);
  const app = createApp({ ...config, trustProxy: [] });
  app.get("/peer", (req) => ({ ip: req.ip }));
  try {
    const r = await app.inject({
      url: "/peer",
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    expect(r.json().ip).toBe("127.0.0.1");
  } finally {
    await app.close();
  }
});

it("expiry heap matches bounded sticky behavior across renewals, churn, previews and sweeps", () => {
  let now = 0;
  const memory = createLabelMemory(7, 100, () => now);
  const model = new Map<string, number>();
  let seed = 19;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let i = 0; i < 1000; i++) {
    now += random() % 4;
    const key = String(random() % 17);
    const deadline = now + 1 + (random() % 100);
    const active = (model.get(key) ?? 0) > now;
    expect(memory.apply(key, human, false).vv_type).toBe(active ? "agent_verified" : "human");
    memory.apply(key, proof, true, deadline);
    const expires = Math.max(active ? model.get(key)! : 0, deadline);
    for (const [savedKey, expiry] of model) if (expiry <= now) model.delete(savedKey);
    model.delete(key);
    model.set(key, expires);
    while (model.size > 7) model.delete(model.keys().next().value!);
    expect(memory.size).toBe(model.size);
    if (i % 11 === 0) memory.sweep();
    if (i % 97 === 0) {
      memory.clear();
      model.clear();
    }
  }
});
