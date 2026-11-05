#!/usr/bin/env node
/**
 * Checks real payloads against Google's Measurement Protocol validation server.
 * Payloads are built by this repository's own code. Requests go to VALIDATION_URL only:
 * events sent there do not appear in reports, and nothing is ever sent to /mp/collect.
 *
 * Usage: GA4_MEASUREMENT_ID=... GA4_API_SECRET=... npm run verify:mp
 * The two values are also read from .env. They are never printed.
 */
import { buildGoogleRequest } from "../dist/server/google.js";

const VALIDATION_URL = "https://www.google-analytics.com/debug/mp/collect";
const STRICT = "ENFORCE_RECOMMENDATIONS";
const RELAXED = "RELAXED";
// Reserved names from the reference, plus the three the reference allows for App streams only.
const RESERVED = "ad_activeview ad_click ad_exposure ad_query ad_reward adunit_exposure app_clear_data app_exception app_install app_remove app_store_refund app_update app_upgrade dynamic_link_app_open dynamic_link_app_update dynamic_link_first_open error firebase_campaign firebase_in_app_message_action firebase_in_app_message_dismiss firebase_in_app_message_impression first_open first_visit notification_dismiss notification_foreground notification_open notification_receive notification_send os_update session_start user_engagement ad_impression in_app_purchase screen_view".split(" ");

// Trimming diagnostics from the repository code would only interrupt the report.
console.warn = () => {};
const measurementId = process.env.GA4_MEASUREMENT_ID ?? "";
const apiSecret = process.env.GA4_API_SECRET ?? "";
if (!/^G-[A-Z0-9]+$/.test(measurementId) || measurementId === "G-XXXXXXXXXX" || !apiSecret || apiSecret.startsWith("replace-")) {
  console.error(`verify:mp needs Google Analytics credentials and has sent nothing.

Set GA4_MEASUREMENT_ID and GA4_API_SECRET in the environment or in .env, then run:

  npm run verify:mp

Use the second property. The values are only used to call ${VALIDATION_URL}.`);
  process.exit(2);
}

const consent = { analytics_storage: "granted", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" };
const device = { browser: "Chrome", model: "Pixel 9 Pro", category: "mobile", language: "en-US", screen_resolution: "1080x2424" };
const location = (length) => "https://www.example.com/".padEnd(length, "a");
function trackingEvent(name, params = {}, extra = {}) {
  const now = Date.now();
  return { event_id: crypto.randomUUID(), name, client_id: "1234567890.1700000000", session_id: 1700000000,
    session_started_ms: now - 1000, session_expires_ms: now + 1_800_000, timestamp_ms: now, consent, device,
    params: { page_location: "https://www.example.com/", page_referrer: "", page_title: "Example", engagement_time_msec: 0, ...params }, ...extra };
}
/** The body the collector would send for this event. */
function built(name, params, extra, mode = "cookie") {
  const event = trackingEvent(name, params, extra);
  const request = buildGoogleRequest({ measurementId, apiSecret, mode }, event, event.consent);
  if (!request) throw new Error(`The repository refused to build ${name}`);
  return request.body;
}

async function validate(body, behavior = STRICT) {
  const url = new URL(VALIDATION_URL);
  url.searchParams.set("measurement_id", measurementId);
  url.searchParams.set("api_secret", apiSecret);
  let response;
  try {
    response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, validation_behavior: behavior }), signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    // Network errors can quote the URL, which carries the secret.
    console.error(`Could not reach the validation server (${error?.name ?? "error"}).`);
    process.exit(1);
  }
  if (!response.ok) { console.error(`The validation server answered HTTP ${response.status}.`); process.exit(1); }
  return (await response.json()).validationMessages ?? [];
}
// Google quotes the offending value in the description; long values would bury the message.
const clean = (text = "") => text.replace(/\[[^\]]{41,}\]/gs, "[...]");
const short = (messages) => messages.map(m => `${m.validationCode ?? "?"} ${m.fieldPath ?? ""}: ${clean(m.description)}`).join("\n      ");
const row = (label, messages) => console.log(`  ${messages.length ? "REJECTED" : "accepted"}  ${label}${messages.length ? `\n      ${short(messages)}` : ""}`);
const heading = (text) => console.log(`\n${text}`);

let repositoryFailures = 0;
async function repository(label, body) {
  const messages = await validate(body);
  repositoryFailures += messages.length ? 1 : 0;
  row(label, messages);
}
/** Largest accepted repeat count, by bisection. */
async function longest(probe, high = 4096) {
  let low = 0;
  if (!(await validate(probe(high))).length) return `>= ${high}`;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if ((await validate(probe(middle))).length) high = middle; else low = middle;
  }
  return low;
}
const withParams = (params) => ({ ...built("page_view"), events: [{ name: "page_view", params: { session_id: 1700000000, engagement_time_msec: 0, ...params } }] });

console.log(`Measurement Protocol validation, ${new Date().toISOString()}`);
console.log(`Endpoint: ${VALIDATION_URL} (validation_behavior ${STRICT} unless stated)`);

heading("1. Payloads built by this repository (these must all be accepted)");
await repository("page_view with campaign_details, device and ip_override",
  built("page_view", {}, { campaign: { source: "newsletter", medium: "email", campaign: "launch" }, ip_override: "192.0.2.1" }));
await repository("purchase with an item", built("purchase", { transaction_id: "order-1", currency: "EUR", value: 42,
  items: [{ item_id: "book", item_name: "Book", price: 42, quantity: 1 }] }));
await repository("page_engagement with measured time", built("page_engagement", { engagement_time_msec: 1200 }));
await repository("cookieless page_view", built("page_view", {}, {}, "cookieless"));
await repository("page_view with a 5000-character URL, referrer and title (trimmed by the repository)",
  built("page_view", { page_location: location(5000), page_referrer: location(5000), page_title: "t".repeat(5000) }));

heading("2. device object");
for (const behavior of [STRICT, RELAXED]) {
  console.log(` validation_behavior ${behavior}`);
  for (const [label, value] of [
    ["full device object", device],
    ["without model", { ...device, model: undefined }],
    ["without browser", { ...device, browser: undefined }],
    ["without model and browser", { ...device, model: undefined, browser: undefined }],
    ["category only", { category: "mobile" }],
    ["empty object", {}],
    ["model and browser only", { model: device.model, browser: device.browser }],
    ["blank model", { ...device, model: "" }],
    ["blank browser", { ...device, browser: " " }],
  ]) row(label, await validate({ ...built("page_view"), device: value }, behavior));
}

heading("3. Reserved event names");
const reserved = [];
for (const name of RESERVED) {
  const event = { name, params: { session_id: 1700000000, engagement_time_msec: 1 } };
  const messages = await validate({ ...built("page_view"), events: [event] });
  reserved.push({ name, messages });
}
const rejected = reserved.filter(r => r.messages.length);
const accepted = reserved.filter(r => !r.messages.length);
console.log(`  rejected ${rejected.length} of ${reserved.length}: ${rejected.map(r => r.name).join(" ")}`);
console.log(`  accepted ${accepted.length} of ${reserved.length}: ${accepted.map(r => r.name).join(" ") || "none"}`);
if (rejected[0]) console.log(`  example: ${short(rejected[0].messages)}`);

heading("4. user_engagement");
for (const behavior of [STRICT, RELAXED])
  row(`user_engagement with engagement_time_msec, ${behavior}`, await validate({ ...built("page_view"),
    events: [{ name: "user_engagement", params: { session_id: 1700000000, engagement_time_msec: 1200 } }] }, behavior));
row("page_engagement (the custom name used here)", await validate(built("page_engagement", { engagement_time_msec: 1200 })));

heading("5. Item parameters");
const standardItem = { item_id: "sku", item_name: "Book", affiliation: "a", coupon: "c", discount: 1, index: 1, item_brand: "b",
  item_category: "c", item_category2: "c", item_category3: "c", item_category4: "c", item_category5: "c", item_list_id: "l",
  item_list_name: "l", item_variant: "v", location_id: "l", price: 1, quantity: 1, creative_name: "c", creative_slot: "c",
  promotion_id: "p", promotion_name: "p" };
const custom = (count) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`custom_${i}`, "x"]));
const withItem = (item) => {
  const body = built("purchase", { transaction_id: "order-1", currency: "EUR", value: 1, items: [{ item_id: "sku" }] });
  body.events.at(-1).params.items = [item];
  return body;
};
for (const count of [10, 11, 26, 27]) row(`item_id plus ${count} custom parameters`, await validate(withItem({ item_id: "sku", ...custom(count) })));
// Near this limit the same request can get different answers, so these rows are repeated.
for (const count of [5, 7, 15]) {
  let rejections = 0;
  for (let attempt = 0; attempt < 12; attempt++)
    if ((await validate(withItem({ ...standardItem, ...custom(count) }))).length) rejections++;
  console.log(`  rejected ${rejections} of 12  all ${Object.keys(standardItem).length} documented fields plus ${count} custom parameters`);
}
row("item_id plus 60 custom parameters, RELAXED", await validate(withItem({ item_id: "sku", ...custom(60) }), RELAXED));

heading("6. Parameters per event");
const manyParams = (count) => withParams(Object.fromEntries(Array.from({ length: count - 2 }, (_, i) => [`param_${i}`, 1])));
row("25 parameters", await validate(manyParams(25)));
row("26 parameters", await validate(manyParams(26)));
row("26 parameters, RELAXED", await validate(manyParams(26), RELAXED));

heading("7. String length (largest accepted repeat count, found by bisection)");
for (const key of ["page_location", "page_referrer", "page_title", "custom_text"]) {
  const counts = [];
  for (const [label, character] of [["1-byte", "t"], ["2-byte", "č"], ["3-byte", "中"], ["4-byte", "😀"]])
    counts.push(`${label} ${await longest((length) => withParams({ [key]: character.repeat(length) }))}`);
  console.log(`  ${key}: ${counts.join(", ")}`);
  console.log(`      ${short(await validate(withParams({ [key]: "t".repeat(2000) })))}`);
  row(`${key} with 2000 characters, RELAXED`, await validate(withParams({ [key]: "t".repeat(2000) }), RELAXED));
}
const itemName = await longest((length) => withItem({ item_id: "sku", item_name: "t".repeat(length) }));
console.log(`  item_name: 1-byte ${itemName}, 2-byte ${await longest((length) => withItem({ item_id: "sku", item_name: "č".repeat(length) }))}`);

heading("8. ip_override");
for (const value of ["192.0.2.1", "2001:db8::1", "not-an-ip"])
  row(`ip_override ${value}`, await validate({ ...built("page_view"), ip_override: value }));

console.log(repositoryFailures ? `\n${repositoryFailures} repository payload(s) rejected.` : "\nAll repository payloads accepted.");
console.log("The validation server checks structure. It does not prove that data appears in reports.");
process.exit(repositoryFailures ? 1 : 0);
