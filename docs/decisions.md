# Design decisions

Author: František Bujnovský.

Each decision names the alternative, the reason and the source. Source labels are explained in the [technical overview](technical-overview.md).

## Measurement Protocol, not /g/collect

**Decision:** send through the documented Measurement Protocol, with the API secret held on the server.

**Alternative:** emulate the browser transport `/g/collect`, as [ga4mp](https://github.com/analytics-debugger/ga4mp) and the [Zaraz GA4 component](https://github.com/managed-components/google-analytics-4) do. That route gets closer to tag behavior, including what MP cannot send.

**Why:** `/g/collect` is not a public contract, so an emulation has to follow Google's script over time. MP has a [reference](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference), a [changelog](https://developers.google.com/analytics/devguides/collection/protocol/ga4/changelog) and a [validator](https://developers.google.com/analytics/devguides/collection/protocol/ga4/validating-events), and Google states it [will remain operational](https://developers.google.com/analytics/devguides/collection/protocol/ga4). The cost is partial reporting, accepted on purpose.

**Source:** Google docs. Whether `/g/collect` reports better for this setup: Not verified, not tested here.

## A second property

**Decision:** Vanilla writes to its own property and never to the one the regular tag uses.

**Alternative:** send MP events into the regular property, joined to the tag's session.

**Why:** nothing deduplicates against the regular pipeline, so a shared property would double-count. Joining would need the tag's identifiers and give up independence. Google says MP alone gives [only partial reporting](https://developers.google.com/analytics/devguides/collection/protocol/ga4), so that limit is kept off the property people report from. Separate properties also allow a direct comparison.

**Source:** Google docs.

## Signed cookie, no database

**Decision:** a signed `HttpOnly` cookie carries identity and session state.

**Alternative:** a server-side store keyed by a random ID, or a browser-readable cookie.

**Why:** no store to run, back up or secure on a small VPS, and no visitor table to hold. `HttpOnly` keeps the value out of page scripts. The server decides when identity starts. The costs: state is signed, not encrypted; concurrent tabs can race; revocation and the first-request bridge are process-local and end with a restart. A database and locking would conflict with the intended deployment.

**Source:** Tested 2026-11-05: `tests/parallel.test.ts`, `tests/consent-races-and-validation.test.ts`.

Safari may cap the cookie at 7 days, and a default install probably falls under that. See [Safari](technical-overview.md#safari) and [WebKit](https://webkit.org/blog/15697/private-browsing-2-0/).

A same-origin reverse proxy can serve `/kx7qpa/s.js` and strip `/kx7qpa/` before forwarding: the tracker resolves `e` and `p` relative to its script URL, `SITE_ORIGIN` must match the website origin, and `COOKIE_DOMAIN` must cover the website host. Tested 2026-11-05: `tests/path-proxy.test.ts`.

## Unknown is not denied

**Decision:** consent has three states. Missing, unresolved and undecided are `unknown`.

**Alternative:** the common two-state model, where anything not granted counts as denied.

**Why:** banners send `denied` long before anyone decides: as a `default`, and in some cases as an `update` at load. A two-state model would treat every new visitor as having refused, fire deletion logic for them, and leave cookieless mode nothing to act on. A regional default cannot be resolved by the script at all. Conservative still holds: in cookie mode `unknown` sends nothing.

**Source:** Live checks in [cookie banners](cookie-banners.md), 2026-11-05. Tested 2026-11-05: `tests/browser.test.ts`, `tests/cmp-adapters.test.ts`.

## Retries, against Google's advice

**Decision:** bounded retries in page memory, only after a network error, a timeout, HTTP 429 or HTTP 5xx: at most 3 attempts, within 30 seconds. Other 4xx are final. The exit `page_engagement` is best-effort and never retried.

**Alternative:** follow the [reference](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference) to the letter: "If you don't get a `2xx` status code, correct any errors in your HTTP request. Don't retry the same request." Or go the other way with a durable queue.

**Why:** a short network failure should not lose a purchase, and a durable queue would bring back the storage this design avoids. The trade is real: a timeout or 5xx can happen after Google accepted the data, so a retry can duplicate an event. Short-lived server deduplication by event ID cannot see Google's state, so this is not exactly-once delivery. A new session is confirmed in the cookie only after success, so `campaign_details` is still present on a retry.

**Source:** Google docs. Tested 2026-11-05: `tests/mp-contract.test.ts`, `tests/delivery-and-privacy.test.ts`.

## Trim page text at the measured limit

**Decision:** `page_location`, `page_referrer` and `page_title` are cut to 256 UTF-8 bytes. Other strings over 100 characters are dropped with a diagnostic.

**Alternative:** the 100 characters of the [reference](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference), which this project used earlier, or the [Help Center](https://support.google.com/analytics/answer/9267744) values of 1,000, 420 and 300.

**Why:** 100 throws away useful URLs. The Help Center values fail strict validation. 256 bytes is the largest value that passes on the validator, and the only one measured. It may be lower than what the live endpoint keeps: Not verified.

**Source:** Tested 2026-11-05: `npm run verify:mp`, [notes](measurement-protocol-notes.md).

## Device fields

**Decision:** `device.model` and `device.browser` are always sent with `device`, with fallbacks. The raw User-Agent is not transmitted.

**Alternative:** send only `category`, as the reference recommends as a minimum, or use the `user_agent` field.

**Why:** strict validation rejects a device object without those two fields although the reference calls them optional. A coarse browser family and model tell Google less about the visitor than a raw User-Agent.

**Source:** Tested 2026-11-05: `npm run verify:mp`.

## Bot filter by User-Agent only

**Decision:** a short server-side list of self-declared automation.

**Alternative:** behavioral scoring, IP lists or fingerprinting.

**Why:** those need storage, upkeep or the kind of visitor inspection this project avoids. The list removes the obvious part and is honest about the rest. See [limits](technical-overview.md#bot-filter).

**Source:** Tested 2026-11-05: `tests/region-and-bots.test.ts`.

## Deliberately left out

| Left out | Why |
| --- | --- |
| Google Ads integration | MP identifiers are joined from tagging, and an independent property has none |
| Cross-domain identity | Needs URL decoration or shared state |
| Durable queue, backfill | Needs storage. Events during downtime are lost; the regular tag is unaffected |
| Browser fingerprinting | Contrary to the purpose of the consent gates |
| Multi-site routing, account service, general tag platform | One server, one site, one destination keeps behavior inspectable |
| Automatic enhanced measurement | Only page views and engagement are automatic. Everything else is an explicit event |
| Getting past content blockers | Not a goal. See [content blockers](technical-overview.md#content-blockers) |
