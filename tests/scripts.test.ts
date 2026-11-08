import { afterEach, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
      .once("error", reject)
      .listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
      });
  });
const until = async (check: () => boolean, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  expect(check()).toBe(true);
};
/** Fails any real outgoing request, which proves the demo does not need the network. */
const noNetwork = `data:text/javascript,globalThis.fetch=()=>{throw new Error("network used")}`;
async function startDemo() {
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", noNetwork, "scripts/demo.mjs"], {
    env: { ...process.env, PORT: String(port) },
  });
  children.push(child);
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  await until(() => output.includes("Open http://localhost"));
  const origin = `http://localhost:${port}`;
  const post = (path: string, body: object, agent = "Mozilla/5.0 Chrome/130.0 Safari/537.36") =>
    fetchReal(origin + path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { origin, "content-type": "application/json", "user-agent": agent },
    });
  return { origin, post, output: () => output };
}
const fetchReal = globalThis.fetch;
const granted = {
  analytics_storage: "granted",
  ad_storage: "denied",
  ad_user_data: "denied",
  ad_personalization: "denied",
};
const event = (name: string, consent: object = granted) => {
  const now = Date.now();
  return {
    event_id: crypto.randomUUID(),
    name,
    client_id: "1.2",
    session_id: 123,
    session_started_ms: now,
    session_expires_ms: now + 1800000,
    timestamp_ms: now,
    consent,
    params: { page_location: "http://localhost/" },
  };
};

it("demo serves the page and tracker, prints what would go to Google and what was blocked", async () => {
  const demo = await startDemo();
  const html = await (await fetchReal(demo.origin)).text();
  for (const label of ["Accept", "Reject", "Withdraw", "page_view", "generate_lead", "purchase"])
    expect(html).toContain(label);
  expect(html).toContain('src="/s.js"');
  expect((await fetchReal(demo.origin + "/s.js")).status).toBe(200);

  const sent = await demo.post("/e", event("generate_lead"));
  expect(sent.status).toBe(204);
  expect(sent.headers.get("set-cookie")).toMatch(
    /^vanilla_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax/,
  );
  await until(() => demo.output().includes("TO GOOGLE  generate_lead"));
  expect(demo.output()).toContain("www.google-analytics.com/g/collect");
  expect(demo.output()).not.toContain("api_secret");
  expect(demo.output()).not.toContain("network used");

  expect(
    (await demo.post("/e", event("purchase", { ...granted, analytics_storage: "denied" }))).status,
  ).toBe(403);
  await until(() => demo.output().includes("BLOCKED    purchase: the collector answered HTTP 403"));

  expect(
    (await demo.post("/e", event("purchase"), "Mozilla/5.0 (compatible; Googlebot/2.1)")).status,
  ).toBe(204);
  await until(() => demo.output().includes("BLOCKED    purchase: obvious bot"));

  expect((await demo.post("/demo/attempt", { name: "purchase", consent: "denied" })).status).toBe(
    204,
  );
  await until(() => demo.output().includes("BLOCKED    purchase: the visitor refused"));

  expect((await demo.post("/p", {})).status).toBe(204);
  await until(() => demo.output().includes("CONSENT    refused or withdrawn"));
});

it("demo does not report an event as blocked once it reached the stub", async () => {
  const demo = await startDemo();
  await demo.post("/demo/attempt", { name: "generate_lead", consent: "granted" });
  await demo.post("/e", event("generate_lead"));
  await until(() => demo.output().includes("TO GOOGLE  generate_lead"));
  await new Promise((resolve) => setTimeout(resolve, 3200));
  expect(demo.output()).not.toContain("BLOCKED");
});
