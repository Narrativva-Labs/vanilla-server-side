# Technical overview

How Vanilla Server-Side works and why it is built this way, for analysts and engineers. To install it, see [INSTALL.md](../INSTALL.md).

Facts carry their source:

- **Tested**: reproducible by this project. Dates and commands are stated; `npm test` covers repository behavior, with the file named.
- **Google docs** and other linked pages: read on 2026-11-05.
- **Not verified**: not confirmed by this project.

## In short

A second, independent GA4 pipeline runs next to the regular tag. It exists for control: the operator owns the identity, the consent decision and every field that leaves for Google. It is not a replacement for tagging, and the regular property stays the reporting system of record.

## Architecture

```text
+-- browser ------------------------------------------------------+
| regular tag ----------------------> regular GA4 property        |
|                                                                 |
| s.js                                                            |
|   reads dataLayer + banner APIs --> consent state               |
|   page views, ecommerce, engagement --> memory queue            |
+-----------------------------------------------------------------+
        |
        | POST /e (JSON, credentials)     POST /p (withdrawal)
        v
+-- collector (Node, Fastify, behind Caddy) ----------------------+
| origin check -> bot filter -> consent -> allowlist -> rate limit|
| signed cookie -> identity -> MP limits -> single Google module  |
+-----------------------------------------------------------------+
        |
        | POST /mp/collect (API secret stays here)
        v
  second GA4 property
```

| Part | Where |
| --- | --- |
| Browser tracker, queue, retries | `src/client/tracker.ts` |
| Consent observer and banner adapters | `src/client/consent.ts`, `src/client/cmp/` |
| Collector routes and order of checks | `src/server/app.ts` |
| Identity and signed cookie | `src/server/identity.ts` |
| Every Google wire-format decision | `src/server/google.ts`, `src/server/mp-validation.ts` |

The one runtime dependency is Fastify. There is no database.

## Data flow

1. The script reads `dataLayer` from the start, in order, so consent and events pushed before it loaded keep their sequence.
2. An event is blocked, held or queued according to [consent](#consent-state-machine).
3. URLs are cleaned in the browser: no credentials, no fragments, no query parameters other than `utm_*`. Click IDs do not leave the browser.
4. The tracker posts JSON to `/e`, resolved relative to the script URL, so a same-origin path proxy works.
5. The collector checks origin and content type, the [bot filter](#bot-filter), consent, the event allowlist, freshness and rate limits.
6. In cookie mode it replaces the browser's temporary identity with the signed server identity. It adds `ip_override` only there.
7. `buildGoogleRequest` applies the limits and sends one MP request. `campaign_details` goes first in the same request at session start.
8. The cookie is set or renewed only after Google answered 2xx.

Tested 2026-11-05: `tests/consent-and-collector.test.ts`, `tests/transport-and-url.test.ts`, `tests/parallel.test.ts`.

## Identity and the signed cookie

The cookie `vanilla_session` holds `base64url(JSON).base64url(HMAC-SHA256)`. The JSON has the client ID, session ID, session start and last activity.

- The server creates a random GA-format client ID only after analytics consent.
- A session ends after 30 minutes of inactivity. That timing lives in the cookie, so no store is needed.
- Attributes: `HttpOnly; Secure; SameSite=Lax; Max-Age=34560000` (400 days) and a `Domain` shared by website and tracker.
- Signatures are compared in constant time. A tampered or malformed cookie starts a fresh identity.
- Signing gives integrity, not confidentiality or replay protection. The content is readable by whoever holds the cookie.
- The first requests of a visit can race before the browser has the cookie. A short process-local bridge keyed by the temporary browser ID gives them the same identity. It does not survive a restart.
- After withdrawal, a process-local map blocks reissuing that identity for 60 seconds, longer than Google's 8-second timeout, so a delayed response cannot bring the cookie back.

Tested 2026-11-05: `tests/parallel.test.ts`, `tests/consent-races-and-validation.test.ts`, `tests/opponent-regressions.test.ts`, `tests/delivery-and-privacy.test.ts`.

Cookieless mode uses none of this: the IDs live in page memory, no cookie is read or written, and a new page load is a new visitor.

### Safari

A cookie set in an HTTP response is capped at 7 days when WebKit sees the request as third-party CNAME or IP address cloaking. [WebKit](https://webkit.org/blog/15697/private-browsing-2-0/) describes the IP test: the two IPv4 addresses share less than 16 bits, or the two IPv6 addresses less than 64 bits, or one is IPv4 and the other IPv6. The defense is on in regular browsing too, and WebKit says it may change.

A default install runs the tracker on a different server from the website, so **it will probably fall under the 7-day limit**. The cookie is renewed on each delivered event (Tested 2026-11-05, `tests/delivery-and-privacy.test.ts`), so a visitor who returns within 7 days should keep the identity. Behavior in a real Safari: Not verified.

A same-origin path proxy, or a tracker in the same network as the website, may avoid this cap. Not verified.

## Consent state machine

Each purpose has three states, and the tracker works from `analytics_storage`:

| | Meaning | Cookie mode | Cookieless mode |
| --- | --- | --- | --- |
| `unknown` | Nobody has decided | Events wait in memory for up to 2 seconds, then are dropped. Nothing is sent and no cookie is set | Events wait up to 2 seconds, then go out with advertising denied |
| `granted` | The visitor agreed | Send | Send, advertising always denied |
| `denied` | Default or refusal | Stop and clear the queues | Stop and clear the queues |

| From | Signal | To | Side effect |
| --- | --- | --- | --- |
| `unknown` | Google `update` granted, or a banner reports a grant | `granted` | Held events and the page view go out |
| `unknown` | Google `default` denied | `denied` | None |
| `unknown` | The banner reports a refusal, or `update` denied without an undecided banner | `denied` | One cookie deletion request |
| `unknown` | `update` denied while a supported banner is undecided | `denied` | None |
| `granted` | Google `update` denied, or the banner reports a refusal | `denied` | Queues cleared, requests aborted, cookie deleted |
| `denied` | Google `update` granted, or a banner reports a grant while Google has not denied | `granted` | In cookie mode a page view goes out, with a new identity |

Sources are merged per key, in rising priority: banner fallback, Google `default`, unresolved regional default, Google `update`. So a banner can never override a direct Google denial, and a partial update changes only its own keys.

Tested 2026-11-05: `tests/browser.test.ts`, `tests/cmp-adapters.test.ts`, `tests/consent-and-collector.test.ts`.

### Why unknown is not denied

`denied` in a default says nothing about a person. Treating it as a refusal causes two real errors: it fires withdrawal logic for people who never chose, and it hides the difference between "waiting" and "said no", which cookieless mode depends on.

- `default` denied is a state, and only an explicit update or a banner's decision triggers a cookie deletion request. Tested: `tests/browser.test.ts`.
- A `default` with `region` stays `unknown`: the script cannot know which region the visitor is in. Tested: `tests/consent-and-collector.test.ts`.
- Some banners send `update` denied at load before the visitor sees anything. Collection stays off, but with an undecided supported banner it is not treated as a refusal and nothing is deleted. Tested: `tests/cmp-adapters.test.ts`. Details: [cookie banners](cookie-banners.md).
- `wait_for_update` is honored for up to 2 seconds.

The regular tag has its own consent handling and is not affected.

## What Measurement Protocol can and cannot do

| | Status | Source |
| --- | --- | --- |
| Create sessions with `session_id`, without `session_start` | Can | [Google docs](https://developers.google.com/analytics/devguides/collection/protocol/ga4/sending-events) |
| Country from `ip_override` | Can, shown in Realtime | Tested 2026-11-05, [notes](measurement-protocol-notes.md#geography-and-device-reach-realtime) |
| City from `ip_override` | Empty in Realtime | Tested 2026-11-05 |
| Device category from `device` | Can, shown in Realtime | Tested 2026-11-05 |
| `ad_user_data`, `ad_personalization` | Can | [Google docs](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference) |
| Reject bad payloads on the live endpoint | Cannot: "doesn't return an error code if the payload is malformed" | [Google docs](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference) |
| Send `first_visit`, `session_start`, `user_engagement` | Cannot: reserved | Tested 2026-11-05, `npm run verify:mp` |
| Show `campaign_details` in DebugView | Cannot | [Google docs](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference/events#campaign_details) |
| Run rules that create or rename events | Cannot | [Google docs](https://developers.google.com/analytics/devguides/collection/protocol/ga4) |
| Session source from `campaign_details` in standard reports | Not verified | [Pending](measurement-protocol-notes.md#pending) |
| New users | Not verified, probably 0 | [Pending](measurement-protocol-notes.md#pending) |

Where the documentation and the validator disagree, see [Measurement Protocol notes](measurement-protocol-notes.md). The main surprises: `device.model` and `device.browser` are required in strict validation although documented as optional, page fields have a measured limit of 256, and limits count UTF-8 bytes.

## Why it runs next to the regular tag

[Google says](https://developers.google.com/analytics/devguides/collection/protocol/ga4):

> You must use tagging (gTag, Tag Manager, or Google Analytics for Firebase) to use this protocol.

> While it's possible to send events to Google Analytics solely with the Measurement Protocol, only partial reporting may be available. The purpose of the Measurement Protocol is to augment existing events collected using gtag, GTM, or Firebase.

Vanilla does not pretend otherwise. The second property has no tag of its own, which puts it in the case Google describes as partial reporting. That is a deliberate trade, and it is why the design has two properties:

- **The regular tag stays untouched** and keeps delivering full reporting, its own consent handling and Ads integrations.
- **The second property takes the partial reporting** in return for independence. Nothing on the production measurement depends on this project, and if the server stops, the regular property does not notice.
- **The streams stay apart.** Nothing deduplicates them, so sharing a property would double-count. Separate properties can also be compared.

The other reading, attaching MP events to a tagged session in the same property, is what Google's [session attribution](https://developers.google.com/analytics/devguides/collection/protocol/ga4/use-cases) covers. This project does not do that: it would need the tag's `client_id` and `session_id`, so the identity would no longer be independent.

## Measurement Protocol status and the Data Manager API

The [Measurement Protocol pages](https://developers.google.com/analytics/devguides/collection/protocol/ga4) open with this notice:

> The Measurement Protocol has reached a mature, finalized product state and will remain operational with no plans for deprecation. However, to ensure your technical setups are future-proofed, we recommend building server-to-server event integrations using the Data Manager API, which is our central infrastructure for future data ingestion innovations.

So the base is stable, and Google points future work elsewhere. The Data Manager API is not used here, for three reasons:

1. **Setup.** It [needs a Google Cloud project and service or user account credentials](https://developers.google.com/data-manager/api/get-started/set-up-access). Measurement Protocol needs one API secret from the Analytics admin screen, which a beginner can copy into an installer.
2. **Same constraint.** Google's [guide](https://developers.google.com/data-manager/api/devguides/events/analytics/recommended-custom-events) says its intent is also "to augment automatic collection", not to replace it. It would not lift partial reporting by itself. Not verified by this project: a [third-party test](https://www.markus-baersch.de/blog/data-manager-api-echter-ersatz-fuer-das-measurement-protocol/) reports no functional gain for GA4 alone and higher latency.
3. **Size.** The transport is one `fetch` in `src/server/google.ts`, with no new runtime dependency.

All Google specifics live in one module, so a move stays a small change if Google's position shifts.

## Bot filter

`src/server/bots.ts` matches self-declared automation in the `User-Agent` request header: names ending in `bot`, crawlers, spiders, headless Chrome, Lighthouse, PageSpeed, common uptime tools and HTTP libraries such as `curl`. The collector answers 204, so the client does not retry, sends nothing to Google, sets no cookie and increments `botsFiltered` on `/health`. Tested 2026-11-05: `tests/region-and-bots.test.ts`.

Limits, stated plainly:

- It only stops clients that say what they are. A bot with a browser User-Agent passes, and so does an empty header.
- It runs on a list, so new names pass until added, and a rare legitimate client could match.
- Your own headless test tools are filtered too.
- Google [excludes known bots](https://support.google.com/analytics/answer/9888366) from its data. Whether that applies to MP events: Not verified, so this filter does not rely on it.

## EU endpoint

`GA4_REGION=eu` sends to `region1.google-analytics.com`. [Google docs](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference): "If you want your data to be collected in the EU, use the following endpoint instead". The default is unchanged. Tested 2026-11-05 at request level: `tests/region-and-bots.test.ts`. The live EU endpoint was not exercised. This setting concerns collection; it is not a statement about where a property stores data.

## Content blockers

The point of this design is control over data and consent, not getting past blockers. There is no promise that the tracker avoids them, and a subdomain name is not a method for that. If a visitor's tool blocks the script, that is a choice to respect. How any particular blocker treats the tracker: Not verified, and not measured. Simo Ahava's [argument on transparency and control in server-side tagging](https://www.simoahava.com/analytics/agency-transparency-control-unsolved-problems-server-side-tagging/) is the position followed here.

## Prior art

None of this is new, and the work below came first.

- **Simo Ahava, 2015.** [Measure ad and content blocker impact](https://www.simoahava.com/analytics/measure-ad-content-blocker-impact-on-traffic/): a bait file detects blockers, and a fallback hit sent by Measurement Protocol to a separate Universal Analytics property, with a server relay suggested.
- **Markus Baersch, 2022.** [GA4 Measurement Protocol for websites, an experiment](https://www.markus-baersch.de/blog/google-analytics-4-measurement-protocol-fuer-websites-experiment/): parallel MP collection compared with gtag. His findings on attribution, `first_visit` and New users are what the [Pending](measurement-protocol-notes.md#pending) list tests against. He pre-dates `ip_override` and `device`, and repeated the test in 2026 with the Data Manager API.
- **[ga4mp](https://github.com/analytics-debugger/ga4mp).** The opposite route: an open implementation of the client-side protocol, with `/g/collect` as its default endpoint. It stays closer to the regular tag; Vanilla stays on the path covered by Google's published Measurement Protocol reference, which does not describe `/g/collect`.
- **[Cloudflare Zaraz](https://developers.cloudflare.com/zaraz/).** Offloads third-party tools to Cloudflare's edge. Its [GA4 component](https://github.com/managed-components/google-analytics-4) also builds requests for `/g/collect`.
- **[ga4-server-side-relay](https://github.com/catesandrew/ga4-server-side-relay).** A self-hosted first-party relay to Measurement Protocol for Next.js and Vercel, close to this project in approach.

## Where to go next

- [Measurement Protocol notes](measurement-protocol-notes.md)
- [Cookie banners](cookie-banners.md)
- [Design decisions](decisions.md)
