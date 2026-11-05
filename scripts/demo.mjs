#!/usr/bin/env node
/**
 * Local demo: the real collector and tracker, with Google replaced by a local stub.
 * It needs no account and makes no outgoing request. It ignores .env on purpose.
 */
import { createApp } from "../dist/server/app.js";
import { isObviousBot } from "../dist/server/bots.js";

const port = Number(process.env.PORT ?? 3210);
const origin = `http://localhost:${port}`;
const HOLD_MS = 3000; // Longer than the tracker's 2-second wait plus its 500 ms polling.

const clock = () => new Date().toTimeString().slice(0, 8);
const line = (label, text, details = []) => {
  console.log(`${clock()}  ${label.padEnd(10)} ${text}`);
  for (const detail of details) console.log(`${" ".repeat(21)}${detail}`);
};

/** Events the page tried to send and that have not reached the stub yet. */
const attempts = [];
function received(name) {
  const index = attempts.findIndex((attempt) => attempt.name === name);
  if (index < 0) return;
  clearTimeout(attempts[index].timer);
  attempts.splice(index, 1);
}

/** Stands in for fetch in the collector: prints what would leave and answers like Google. */
async function fakeGoogle(url, init) {
  const { host, pathname } = new URL(url);
  const { events, client_id, consent, device, ip_override } = JSON.parse(init.body);
  for (const { name, params } of events) {
    received(name);
    line("TO GOOGLE", `${name}  ->  ${host}${pathname}`, [
      `client_id ${client_id}  session_id ${params.session_id}`,
      `ad_user_data ${consent.ad_user_data}  ad_personalization ${consent.ad_personalization}`,
      ...(device ? [`device ${device.browser} / ${device.model} / ${device.category}`] : []),
      `ip_override ${ip_override}`,
      `params ${JSON.stringify(params)}`,
    ]);
  }
  return new Response(null, { status: 204 });
}

const reasons = {
  denied: "the visitor refused, so nothing left the browser",
  unknown: "no decision within 2 seconds, so the event was dropped from memory",
  granted: "it never reached the collector",
};

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vanilla Server-Side demo</title>
<style>
  :root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
  body { margin: 0 auto; max-width: 40rem; padding: 1rem 1rem 11rem; }
  h1 { font-size: 1.4rem; }
  .row { display: flex; flex-wrap: wrap; gap: .5rem; }
  button { font: inherit; padding: .5rem .9rem; cursor: pointer; }
  #banner { position: fixed; inset: auto 0 0; padding: 1rem; background: Canvas; border-top: 1px solid GrayText; }
  #banner p { margin: 0 0 .5rem; }
</style>
</head>
<body>
<h1>Vanilla Server-Side demo</h1>
<p>Watch the terminal: it shows what would go to Google and what was blocked.</p>
<div class="row">
  <button data-event="page_view">page_view</button>
  <button data-event="generate_lead">generate_lead</button>
  <button data-event="purchase">purchase</button>
</div>
<div id="banner">
  <p>Consent: <strong id="state">undecided</strong></p>
  <div class="row">
    <button data-consent="granted">Accept</button>
    <button data-consent="denied">Reject</button>
    <button data-consent="denied" data-withdraw>Withdraw</button>
  </div>
</div>
<script>
  window.dataLayer = window.dataLayer || [];
  let consent = "unknown";
  let views = 1;
  // The banner above speaks the CookieConsent interface, one of the supported banners.
  window.CookieConsent = { validConsent: () => consent !== "unknown", acceptedCategory: () => consent === "granted" };
  const report = (body) => fetch("/demo/attempt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  report({ opened: true });
  document.addEventListener("click", ({ target }) => {
    if (target.dataset.consent) {
      consent = target.dataset.consent;
      document.getElementById("state").textContent = "withdraw" in target.dataset ? "withdrawn" : consent;
      window.dispatchEvent(new Event("cc:onConsent"));
    }
    const name = target.dataset.event;
    if (!name) return;
    report({ name, consent });
    // page_view is automatic: a same-document navigation is what triggers it.
    if (name === "page_view") history.pushState({}, "", "/page-" + ++views);
    if (name === "generate_lead") dataLayer.push({ event: name });
    if (name === "purchase") dataLayer.push({ event: name, ecommerce: { transaction_id: "demo-" + Date.now(), currency: "EUR", value: 42,
      items: [{ item_id: "book", item_name: "Book", price: 42, quantity: 1 }] } });
  });
</script>
<script defer src="/s.js"></script>
</body>
</html>`;

const app = createApp(
  {
    siteOrigin: origin,
    cookieDomain: "localhost",
    cookieSecret: "demo-only-".repeat(4),
    measurementId: "G-DEMO",
    apiSecret: "demo",
  },
  fakeGoogle,
);
app.get("/", (_, reply) => reply.type("text/html").send(page));
app.get("/page-:number", (_, reply) => reply.type("text/html").send(page));
app.post("/demo/attempt", (req, reply) => {
  const { name, consent, opened } = req.body ?? {};
  if (opened) line("PAGE", "opened: consent undecided, no identity yet");
  if (typeof name === "string") {
    const attempt = {
      name,
      timer: setTimeout(() => {
        attempts.splice(attempts.indexOf(attempt), 1);
        line("BLOCKED", `${name}: ${reasons[consent] ?? reasons.granted}`);
      }, HOLD_MS),
    };
    attempts.push(attempt);
  }
  return reply.code(204).send();
});
// Production cookies need HTTPS and a real domain; plain http://localhost accepts neither everywhere.
app.addHook("onSend", async (req, reply) => {
  const cookie = reply.getHeader("set-cookie");
  if (typeof cookie !== "string") return;
  reply.removeHeader("set-cookie");
  reply.header("set-cookie", cookie.replace(/; Domain=[^;]+/, "").replace("; Secure", ""));
  line(
    "COOKIE",
    req.url === "/p" ? "vanilla_session deleted" : "vanilla_session set: signed, HttpOnly",
  );
});
app.addHook("onResponse", async (req, reply) => {
  if (req.method !== "POST") return;
  if (req.url === "/p")
    line(
      "CONSENT",
      "refused or withdrawn: the tracker cleared its queue and asked the server to delete the cookie",
    );
  if (req.url !== "/e") return;
  const name = req.body?.name ?? "event";
  if (isObviousBot(req.headers["user-agent"]))
    line("BLOCKED", `${name}: obvious bot by User-Agent, nothing sent to Google`);
  else if (reply.statusCode >= 400)
    line("BLOCKED", `${name}: the collector answered HTTP ${reply.statusCode}`);
});

await app.listen({ host: "localhost", port });
console.log("Vanilla Server-Side demo. Google is a local stub: nothing leaves this computer.");
console.log(`Open ${origin} and press Ctrl+C here to stop.\n`);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
