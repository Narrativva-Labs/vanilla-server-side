# Technical overview

How Vanilla Server-Side works and why it is built this way, for analysts and engineers. To install it, see [INSTALL.md](../INSTALL.md).

Facts carry their source:

- **Tested**: run by this project, with date and method. `npm test` and `npm run test:e2e` can be rerun by anyone. Realtime results and the [browser checks](measurement-protocol-notes.md#browser-checks) are single manual runs and cannot be repeated by a command.
- **Google docs** and other linked pages: read on 2026-11-05.
- **Not verified**: not confirmed by this project.

## In short

A second, independent GA4 pipeline runs next to the regular tag. It exists for control: the operator decides the identity, the consent rules and every field that leaves for Google. The data itself still ends up at Google. It is not a replacement for tagging, and the regular property stays the reporting system of record.

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
        | POST /e (events)   POST /p (withdrawal)   POST /d (denied ping)
        v
+-- collector (Node, Fastify, behind Caddy) ----------------------+
| origin check -> bot filter -> consent -> allowlist -> rate limit|
| signed cookie -> identity -> parameter limits -> single Google module  |
+-----------------------------------------------------------------+
        |
        | POST /g/collect (every event, denied ping)
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
3. URLs are cleaned in the browser, including a `page_location` or other URL parameter set by the site: no credentials, no fragments, no query parameters other than `utm_*`. Click IDs travel in their own `click_ids` field, on page views only, and only with `ad_storage` and `ad_user_data` granted.
4. The tracker posts JSON to `/e`, resolved relative to the script URL, so a same-origin path proxy works.
5. The collector checks origin and content type, the [bot filter](#bot-filter), consent, the event allowlist, freshness and rate limits. The consent check reads the state the browser reports; the server cannot confirm it independently.
6. It replaces the browser's temporary identity with the signed server identity and adds the visitor IP.
7. Every event goes through `buildEventCollectUrl`, which cleans URLs, removes advertising identifiers outside consent, validates parameters and builds one `/g/collect` POST with the real event name. The first event carries `_ss` and, for a new visitor, `_fv`. Parallel events wait for session opening; failed openings remain retryable. There is no second upstream request.
8. Text parameters use `ep.*`, numbers `epn.*`, currency `cu`, items `pr1`…`prN`. `_p` identifies a tracker page and `_s` counts its events, including final `page_engagement`; retries retain both. Without tracker metadata, each hit gets random `_p` and `_s=1`. `seg=1` on a non-opening page view or `_et >= 10000`. Over 2000 URL bytes, the event, its parameters and items move to a one-line POST body as in the Google tag; an event above 64 KiB is dropped with a diagnostic. Collect cannot backdate events: `timely()` and the tracker's 30-second queue limit remain in force. See [wire format](measurement-protocol-notes.md#collect-wire-format).
9. The cookie is set or renewed only after Google answered 2xx.

Tested 2026-11-06: `tests/collect.test.ts`, `tests/consent-and-collector.test.ts`, `tests/transport-and-url.test.ts`, `tests/parallel.test.ts`.

## Identity and the signed cookie

The cookie `vanilla_session` holds `base64url(JSON).base64url(HMAC-SHA256)`. The JSON has the client ID, session ID, session start and last activity.

- The server creates a random GA-format client ID only after analytics consent.
- A session ends after 30 minutes of inactivity or after 24 hours. That timing lives in the cookie, so no store is needed.
- Attributes: `HttpOnly; Secure; SameSite=Lax; Max-Age=34560000` (400 days) and a `Domain` shared by website and tracker.
- Signatures are compared in constant time. A tampered or malformed cookie starts a fresh identity.
- Signing gives integrity, not confidentiality or replay protection. The content is readable by whoever holds the cookie.
- The first requests of a visit can race before the browser has the cookie. A short process-local bridge keyed by the temporary browser ID gives them the same identity. It does not survive a restart.
- After withdrawal, a process-local map blocks reissuing that identity for 60 seconds, longer than Google's 8-second timeout, so a delayed response cannot bring the cookie back.

Tested 2026-11-05: `tests/parallel.test.ts`, `tests/consent-races-and-validation.test.ts`, `tests/delivery-races.test.ts`, `tests/delivery-and-privacy.test.ts`.

### Safari

A cookie set in an HTTP response is capped at 7 days when WebKit sees the request as third-party CNAME or IP address cloaking. [WebKit](https://webkit.org/blog/15697/private-browsing-2-0/) describes the IP test: the two IPv4 addresses share less than 16 bits, or the two IPv6 addresses less than 64 bits, or one is IPv4 and the other IPv6. The defense is on in regular browsing too, and WebKit says it may change.

**Tested 2026-11-05, one run:** Safari 26.6.2 stored the server-set `vanilla_session` for 7.0 days, with the tracker on a different IPv4 /16 from the website and 400 days requested by the server ([notes](measurement-protocol-notes.md#browser-checks)). A default install runs the tracker on a different server from the website, so expect the same.

The server renews the cookie on each delivered event (Tested 2026-11-05, `tests/delivery-and-privacy.test.ts`). Whether Safari then keeps the identity for a visitor who returns within 7 days: Not verified.

A same-origin path proxy, or a tracker in the same network as the website, may avoid this cap. Not verified.

## Consent state machine

Each purpose has three states, and the tracker works from `analytics_storage`:

| | Meaning | What the tracker does |
| --- | --- | --- |
| `unknown` | No signal, or an undecided banner with no Google state | Events wait in memory until the visitor decides, at most 50 per page. Nothing is sent and no cookie is set |
| `granted` | The visitor agreed | Send |
| `denied` | Default or refusal | Nothing is sent. Denied by a default alone, while a supported banner is still undecided, events wait in memory like `unknown`; a refusal clears them and the queues. After 2 seconds in this state, one limited ping to `/d` per page, unless consent already measured that page |

| From | Signal | To | Side effect |
| --- | --- | --- | --- |
| `unknown`, or `denied` by a default | Google `update` granted, or a banner reports a grant | `granted` | Held events and the page view go out |
| `unknown` | Google `default` denied | `denied` | None |
| `unknown` | The banner reports a refusal, or `update` denied without an undecided banner | `denied` | One cookie deletion request |
| `unknown` | `update` denied while a supported banner is undecided | `denied` | None |
| `granted` | Google `update` denied, or a banner refusal that outranks the grant | `denied` | Queues cleared, requests aborted, cookie deleted |
| `denied` by an update or a refusal | Google `update` granted, or a banner grant that outranks the denial | `granted` | A page view goes out. The identity is new only if the cookie was deleted; a cookie still in the browser keeps its identity |

Sources are merged per key, in rising priority: Google `default`, unresolved regional default, decided banner, Google `update`. An undecided banner adds nothing. A partial update changes only its own keys.

Time decides between a banner and an `update`:

- The first read of a banner reports a stored state. It beats every `default`, and it does not override an `update` already seen.
- A later change in the banner is a new decision and removes older `update` values for the keys it changes. This covers banners that send no `update` after a click, such as the CookieYes WordPress plugin.
- A later `update` beats the banner again, so the newest decision wins. A banner change is recorded before each incoming Google command, so the order is kept even between two polls.
- A change made before the script loaded cannot be seen as a change, so it counts as a first read.

Tested 2026-11-05: `tests/browser.test.ts`, `tests/cmp-adapters.test.ts`, `tests/consent-and-collector.test.ts`.

### Consent rules

All of this is one pure function in `src/client/consent.ts`: `nextConsent(state, signal)` returns the new state, with no DOM and no clock. Around it, the observer only reads `dataLayer` and the banners and keeps the `wait_for_update` timer.

The tables below are the rows of `tests/consent-rules.test.ts`, and the test fails if they differ from it. Signals run oldest first. A value is `analytics_storage`, or `analytics_storage/ad_storage`, and `-` leaves a purpose out. `regional` is a `default` limited to a `region`, `banner gone` means no supported banner can be read any more, and `handled` means the tracker has taken the pending refusal.

Which state wins:

| Rule | Signals | Result |
| --- | --- | --- |
| With no signal a purpose is unknown | none | `unknown` |
| A Google default sets the starting value | `default denied` | `denied` |
| A newer default replaces an older one | `default denied, default granted` | `granted` |
| A regional default stays unknown, whatever it says | `regional granted` | `unknown` |
| A regional default beats an older general default | `default granted, regional denied` | `unknown` |
| A regional default beats a newer general default | `regional denied, default granted` | `unknown` |
| An undecided banner adds nothing | `default denied, banner undecided` | `denied` |
| A decided banner beats a Google default | `default denied, banner granted` | `granted` |
| A decided banner beats a regional default | `regional denied, banner granted` | `granted` |
| A Google update beats a Google default | `default denied, update granted` | `granted` |
| A Google update beats a regional default | `regional denied, update granted` | `granted` |
| A Google update beats the first banner read | `update denied, banner granted` | `denied` |
| A Google update beats a banner decided earlier | `banner granted, update denied` | `denied` |
| A banner that repeats itself is no new decision | `banner granted, update denied, banner granted` | `denied` |
| A later banner change beats an older update | `banner undecided, update denied, banner granted` | `granted` |
| A later update beats an older banner change | `banner undecided, banner granted, update denied` | `denied` |
| The newest decision wins, however often it changes | `banner granted, update granted, banner denied, update granted, banner granted, banner denied` | `denied` |
| A banner change replaces only the purposes it changes | `banner granted/denied, update denied/denied, banner granted/granted` | `denied/granted` |
| A banner turning undecided keeps the update | `banner granted, update denied, banner undecided` | `denied` |
| A banner that disappears stops counting | `default denied, banner granted, banner gone` | `denied` |
| A banner that returns unchanged is no new decision | `banner granted, update denied, banner gone, banner granted` | `denied` |
| A banner that returns changed is a new decision | `banner denied, update denied, banner gone, banner granted` | `granted` |
| A partial update changes only the purposes it names | `update granted/denied, update -/granted` | `granted/granted` |
| A value that is not a decision counts as unknown | `default granted, update maybe` | `unknown` |

Whether the tracker asks the server to delete the cookie:

| Rule | Signals | Deletion request |
| --- | --- | --- |
| A Google default is not a refusal | `default denied` | `false` |
| A grant is not a refusal | `update granted, banner granted` | `false` |
| An update denied is a refusal | `update denied` | `true` |
| An undecided banner cancels an update denied | `update denied, banner undecided` | `false` |
| A decided banner keeps an update denied | `update denied, banner granted` | `true` |
| A disappearing banner keeps an update denied | `update denied, banner gone` | `true` |
| A banner reporting denied is a refusal | `banner undecided, banner denied` | `true` |
| A banner refusal counts once | `banner denied, handled, banner denied` | `false` |
| A banner refusal counts again after a grant | `banner denied, handled, banner granted, banner denied` | `true` |
| An update denied counts every time | `update denied, handled, update denied` | `true` |

### Real browsers

`npm run test:e2e` starts `scripts/demo.mjs` and drives it in headless Chromium and WebKit through Playwright, on every push. Tested 2026-11-05, `tests/e2e/consent.spec.ts`:

- Without a decision no request reaches `/e` or `/p`, nothing goes to the stub and no cookie exists.
- Accepting sends the page view and creates a cookie marked `HttpOnly` that page scripts cannot read.
- Rejecting sends one deletion request, one limited ping, no event and no cookie.
- Withdrawing deletes the cookie and stops later events.
- A same-document navigation sends one `page_view`, and repeating the same address sends none.

Limits: the demo runs on plain `http://localhost`, so it drops the `Secure` and `Domain` cookie attributes, and it reads the banner through the CookieConsent interface only. Playwright's WebKit is not Safari, so the [cap on cookie lifetime](#safari) stays outside these tests.

### Why unknown is not denied

`denied` in a default says nothing about a person. Collection stops all the same, but treating it as a refusal would fire withdrawal logic for people who never chose. `unknown` is the state with no signal at all.

- `default` denied is a state, and only an explicit update or a banner's decision triggers a cookie deletion request. Tested: `tests/browser.test.ts`.
- A `default` with `region` stays `unknown` until an update or a decided banner: the script cannot know which region the visitor is in. Tested: `tests/consent-and-collector.test.ts`, `tests/cmp-adapters.test.ts`.
- Some banners send `update` denied at load before the visitor sees anything. Collection stays off, but with an undecided supported banner it is not treated as a refusal and nothing is deleted. Tested: `tests/cmp-adapters.test.ts`. Details: [cookie banners](cookie-banners.md).
- `wait_for_update` is honored for up to 2 seconds.

The regular tag has its own consent handling and is not affected.

## Historical Measurement Protocol findings

Measurement Protocol was removed on 2026-11-08 after the [mixed transport comparison](measurement-protocol-notes.md#all-collect-comparison). The table below records earlier experiments, not the current transport.

| | Status | Source |
| --- | --- | --- |
| Create sessions with `session_id`, without `session_start` | Can | [Google docs](https://developers.google.com/analytics/devguides/collection/protocol/ga4/sending-events) |
| Country from `ip_override` | Can, shown in Realtime | Tested 2026-11-05, [notes](measurement-protocol-notes.md#geography-and-device-reach-realtime) |
| City from `ip_override` | Empty in Realtime | Tested 2026-11-05 |
| Device category from `device` | Can, shown in Realtime | Tested 2026-11-05 |
| `ad_user_data`, `ad_personalization` | Can | [Google docs](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference) |
| Reject bad payloads on the live endpoint | Cannot: "doesn't return an error code if the payload is malformed" | [Google docs](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference) |
| Send `first_visit`, `session_start`, `user_engagement` | Cannot: reserved | Tested 2026-11-05, historical MP validator run (script retired) |
| Show `campaign_details` in DebugView | Cannot | [Google docs](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference/events#campaign_details) |
| Run rules that create or rename events | Cannot | [Google docs](https://developers.google.com/analytics/devguides/collection/protocol/ga4) |
| Session source from `campaign_details` in standard reports | Not in our test: 70 of 70 sessions `(not set)` | Tested 2026-11-06, [notes](measurement-protocol-notes.md#gcollect) |
| New users | Not in our test: 0 | Tested 2026-11-06, [notes](measurement-protocol-notes.md#gcollect) |

Where the documentation and the validator disagree, see [Measurement Protocol notes](measurement-protocol-notes.md). The main surprises: `device.model` and `device.browser` are required in strict validation although documented as optional, page fields have a measured limit of 256, and limits count UTF-8 bytes.

## Why it runs next to the regular tag

[Google says](https://developers.google.com/analytics/devguides/collection/protocol/ga4):

> You must use tagging (gTag, Tag Manager, or Google Analytics for Firebase) to use this protocol.

> While it's possible to send events to Google Analytics solely with the Measurement Protocol, only partial reporting may be available. The purpose of the Measurement Protocol is to augment existing events collected using gtag, GTM, or Firebase.

Vanilla does not pretend otherwise. The second property has no tag of its own, which puts it in the case Google describes as partial reporting, and a test confirmed it: without `/g/collect` there was no session source and no new users. All events now use collect to keep their session attribution. It is why the design has two properties:

- **The regular tag stays untouched** and keeps delivering full reporting, its own consent handling and Ads integrations.
- **The second property keeps an independent identity and transport.** Nothing on the production measurement depends on this project, and if the server stops, the regular property does not notice.
- **The streams stay apart.** Nothing deduplicates them, so sharing a property would double-count. Separate properties can also be compared.

The other reading, attaching MP events to a tagged session in the same property, is what Google's [session attribution](https://developers.google.com/analytics/devguides/collection/protocol/ga4/use-cases) covers. This project does not do that: it would need the tag's `client_id` and `session_id`, so the identity would no longer be independent.

## Measurement Protocol status and the Data Manager API

The [Measurement Protocol pages](https://developers.google.com/analytics/devguides/collection/protocol/ga4) open with this notice:

> The Measurement Protocol has reached a mature, finalized product state and will remain operational with no plans for deprecation. However, to ensure your technical setups are future-proofed, we recommend building server-to-server event integrations using the Data Manager API, which is our central infrastructure for future data ingestion innovations.

So the base is stable, and Google points future work elsewhere. The Data Manager API is not used here, for three reasons:

1. **Setup.** It [needs a Google Cloud project and service or user account credentials](https://developers.google.com/data-manager/api/devguides/quickstart/set-up-access). Collect needs only the web stream Measurement ID.
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

A default install uses a neutral random subdomain such as `kx7qpa.example.com` and the neutral paths `/s.js`, `/e`, `/p` and `/d`. Filter lists match known names and paths, so this lowers the chance of being caught. It guarantees nothing: first-party does not mean unblockable, and a list can add any name or pattern.

Tested 2026-11-05, one run: with uBlock Origin Lite and default lists in Chromium, the regular tag was stopped and the tracker was not ([notes](measurement-protocol-notes.md#browser-checks)). Other blockers, stricter lists and other browsers: Not verified.

Consent works the same with or without a blocker. No event leaves without consent, and a refusal stops regular measurement, as described in the [consent state machine](#consent-state-machine).

Simo Ahava [disagrees with this approach](https://www.simoahava.com/analytics/agency-transparency-control-unsolved-problems-server-side-tagging/). He argues that a first-party subdomain hides the vendor domain that blockers match, which erodes the visitor's control, and that what happens on the server cannot be audited from the browser. Both points apply to a default install, and this project does not refute them.

The project's position: a blocker does not overrule the visitor's decision in the cookie banner. That decision is what governs measurement here, so a visitor who refuses is not measured beyond the limited ping, whatever their blocker does.

## Prior art

None of this is new, and the work below came first.

- **Simo Ahava, 2015.** [Measure ad and content blocker impact](https://www.simoahava.com/analytics/measure-ad-content-blocker-impact-on-traffic/): a bait file detects blockers, and a fallback hit sent by Measurement Protocol to a separate Universal Analytics property, with a server relay suggested.
- **Markus Baersch, 2022.** [GA4 Measurement Protocol for websites, an experiment](https://www.markus-baersch.de/blog/google-analytics-4-measurement-protocol-fuer-websites-experiment/): parallel MP collection compared with gtag. His findings on attribution, `first_visit` and New users are what the [Pending](measurement-protocol-notes.md#pending) list tests against. He pre-dates `ip_override` and `device`, and repeated the test in 2026 with the Data Manager API.
- **[ga4mp](https://github.com/analytics-debugger/ga4mp).** The opposite route: an open implementation of the client-side protocol, with `/g/collect` as its default endpoint. It stays closer to the regular tag; Vanilla now uses the same collect transport for every event.
- **[Cloudflare Zaraz](https://developers.cloudflare.com/zaraz/).** Offloads third-party tools to Cloudflare's edge. Its [GA4 component](https://github.com/managed-components/google-analytics-4) also builds requests for `/g/collect`.
- **[ga4-server-side-relay](https://github.com/catesandrew/ga4-server-side-relay).** A self-hosted first-party relay to Measurement Protocol for Next.js and Vercel, close to this project in approach.

## Where to go next

- [Measurement Protocol notes](measurement-protocol-notes.md)
- [Cookie banners](cookie-banners.md)
- [Design decisions](decisions.md)
