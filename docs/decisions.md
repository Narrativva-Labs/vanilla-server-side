# Design decisions

Author: František Bujnovský.

Each decision names the alternative, the reason and the source. Source labels are explained in the [technical overview](technical-overview.md).

## /g/collect opens a session, Measurement Protocol carries the rest

**Decision:** the first page view of a session goes only through `/g/collect`. Other events go through the documented Measurement Protocol, with the API secret held on the server. There are two exceptions: a session opened by another event, for example after 30 idle minutes, gets a short `/g/collect` hit first and its data follow through MP, and a page view with a click ID inside a running session goes through `/g/collect` without starting a session.

**Alternative:** Measurement Protocol only, which this project started with. Or `/g/collect` for everything, as [ga4mp](https://github.com/analytics-debugger/ga4mp) and the [Zaraz GA4 component](https://github.com/managed-components/google-analytics-4) do.

**Why:** MP alone did not work for acquisition. All 70 test sessions showed source `(not set)` and 0 new users, including the ones sent with `campaign_details`. `/g/collect` produced `session_start` and `first_visit` at once, which MP refuses as reserved names. It is not a public contract, so it is used as little as possible: usually one hit per session, with a small fixed set of fields. Ecommerce and custom events stay on the path that has a [reference](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference) and a [validator](https://developers.google.com/analytics/devguides/collection/protocol/ga4/validating-events).

**Source:** Tested 2026-11-06, [notes](measurement-protocol-notes.md#gcollect).

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

Safari capped the cookie at 7 days in one measured run: Safari 26.6.2 stored 7.0 days for the server-set cookie with the tracker on a different IPv4 /16 from the website. Tested 2026-11-05, one run. Keeping the identity through renewal on return, and avoiding the cap with a same-origin proxy: Not verified. See [Safari](technical-overview.md#safari) and [WebKit](https://webkit.org/blog/15697/private-browsing-2-0/).

A same-origin reverse proxy can serve `/kx7qpa/s.js` and strip `/kx7qpa/` before forwarding: the tracker resolves `e`, `p` and `d` relative to its script URL, `SITE_ORIGIN` must match the website origin, and `COOKIE_DOMAIN` must cover the website host. Tested 2026-11-05: `tests/path-proxy.test.ts`.

## Unknown is not denied

**Decision:** consent has three states. Missing, unresolved and undecided are `unknown`.

**Alternative:** the common two-state model, where anything not granted counts as denied.

**Why:** banners send `denied` long before anyone decides: as a `default`, and in some cases as an `update` at load. A two-state model would treat every new visitor as having refused and fire deletion logic for them. The script cannot resolve a regional default by itself; only an update or a decided banner does. Conservative still holds: `unknown` sends nothing.

Google state does not always win. A decided banner beats every `default`, because some banners send no `update` after the click. Between a banner and an `update` the newest decision wins, and the banner's first read at load does not count as new. See the [consent state machine](technical-overview.md#consent-state-machine).

**Source:** Live checks in [cookie banners](cookie-banners.md), 2026-11-05. Tested 2026-11-05: `tests/browser.test.ts`, `tests/cmp-adapters.test.ts`.

## One mode, with a cookie

**Decision:** the tracker waits for analytics consent, then uses the signed cookie. The earlier cookieless mode was removed.

**Alternative:** keep cookieless as a second mode, with an identity in page memory and sending before a decision when there was no consent signal.

**Why:** with most banners, which set `default` denied, it measured nothing without a decision anyway. After consent the cookie mode is better: the identity survives a page load and geography works. And the second mode added complexity to every consent, identity and delivery path.

**Source:** Live checks in [cookie banners](cookie-banners.md), 2026-11-05.

## Limited pings without consent

**Decision:** a page that stays denied for 2 seconds sends one `/g/collect` hit with its real consent state, `gcs=G100` when both storages are denied, a one-off ID, no cookie, no visitor IP and no click IDs.

**Alternative:** send nothing, which is what this project did first. Or send at once, as the Google tag does.

**Why:** this is the shape of a cookieless ping in Advanced Consent Mode, seen in a captured Google tag hit. The Google tag sends its hit at once and no second `page_view` after a grant. Vanilla sends its full page view only after a grant, so sending at once would leave a refusal behind on each page load of a visitor whose banner restores a grant a moment later. The 2 seconds avoid that. A visitor who refuses and leaves within 2 seconds is not pinged, and one who accepts after 2 seconds leaves a ping as well as the full page view.

**Source:** Tested 2026-11-06, `tests/collect.test.ts`, [notes](measurement-protocol-notes.md#gcollect). Effect on reports and modeling: Not verified. Google's [behavioral modeling](https://support.google.com/analytics/answer/11161109) needs at least 1,000 denied events a day for 7 days and 1,000 daily granted users, and it describes Google tags on the page, so a small site should expect no effect. That is why `DENIED_PINGS=off` turns the ping off: it follows the Google tag's behavior by default, and whether it is worth having depends on the site.

## Retries, against Google's advice

**Decision:** bounded retries in page memory, only after a network error, a timeout, HTTP 429 or HTTP 5xx: at most 3 attempts, within 30 seconds. Other 4xx are final. The exit `page_engagement` is best-effort and never retried.

**Alternative:** follow the [reference](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference) to the letter: "If you don't get a `2xx` status code, correct any errors in your HTTP request. Don't retry the same request." Or go the other way with a durable queue.

**Why:** a short network failure should not lose a purchase, and a durable queue would bring back the storage this design avoids. The trade is real: a timeout or 5xx can happen after Google accepted the data, so a retry can duplicate an event. Short-lived server deduplication by event ID cannot see Google's state, so this is not exactly-once delivery. A session counts as open once `/g/collect` answered 2xx: the cookie goes out then, even if the Measurement Protocol half fails, so a retry repeats only the event. Events wait behind a page view that is being retried, because it may be the one opening the session.

**Source:** Google docs. Tested 2026-11-05: `tests/mp-contract.test.ts`, `tests/delivery-and-privacy.test.ts`.

## Trim page text at the measured limit

**Decision:** `page_location`, `page_referrer` and `page_title` are cut to 256 UTF-8 bytes. Other strings over 100 characters are dropped with a diagnostic.

**Alternative:** the 100 characters of the [reference](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference), which this project used earlier, or the [Help Center](https://support.google.com/analytics/answer/9267744) values of 1,000, 420 and 300.

**Why:** 100 throws away useful URLs. The Help Center values fail strict validation. 256 bytes is the largest value that passes on the validator, and the only one measured. It may be lower than what the live endpoint keeps: Not verified.

**Source:** Tested 2026-11-05: `npm run verify:mp`, [notes](measurement-protocol-notes.md).

## Device fields

**Decision:** `device.model` and `device.browser` are always sent with `device`, with fallbacks. Measurement Protocol requests carry no raw User-Agent. The `/g/collect` hit does, as a browser's own hit would, in the HTTP header.

**Alternative:** send only `category`, as the reference recommends as a minimum, or use the `user_agent` field.

**Why:** strict validation rejects a device object without those two fields although the reference calls them optional. A coarse browser family and model tell Google less about the visitor than a raw User-Agent.

**Source:** Tested 2026-11-05: `npm run verify:mp`.

## Bot filter by User-Agent only

**Decision:** a short server-side list of self-declared automation.

**Alternative:** behavioral scoring, IP lists or fingerprinting.

**Why:** those need storage, upkeep or the kind of visitor inspection this project avoids. The list removes the obvious part and is honest about the rest. See [limits](technical-overview.md#bot-filter).

**Source:** Tested 2026-11-05: `tests/region-and-bots.test.ts`.

## Neutral names

**Decision:** a default install uses a neutral random subdomain and the neutral paths `/s.js`, `/e` and `/p`.

**Alternative:** a descriptive name such as an analytics subdomain, or a vendor domain.

**Why:** the main purpose of this project is control over data and consent. Fewer blocked requests are a side benefit, not the reason it exists. Neutral names lower the chance of a filter list match. They guarantee nothing, and first-party does not mean unblockable. A blocker does not overrule the visitor's decision in the cookie banner: no event is sent without consent, and a refusal stops collection. Simo Ahava disagrees with this approach; see [content blockers](technical-overview.md#content-blockers).

**Source:** Tested 2026-11-05, one run with uBlock Origin Lite: [notes](measurement-protocol-notes.md#browser-checks). Other blockers: Not verified.

## Deliberately left out

| Left out | Why |
| --- | --- |
| Direct Google Ads integration | Ads is reached through the GA4 link only. No conversion API, no second destination |
| Cross-domain identity | Needs URL decoration or shared state |
| Durable queue, backfill | Needs storage. Events during downtime are lost; the regular tag is unaffected |
| Browser fingerprinting | Contrary to the purpose of the consent gates |
| Multi-site routing, account service, general tag platform | One server, one site, one destination keeps behavior inspectable |
| Automatic enhanced measurement | Only page views and engagement are automatic. Everything else is an explicit event |
