# Vanilla Server-Side

**[Install it](INSTALL.md)** | **[Understand how it works](docs/technical-overview.md)**

A small, self-hosted analytics collector by František Bujnovský. Your regular Google Analytics stays exactly as it is. Next to it, a tiny script sends events to your own server, and your server forwards them to a **second, separate** Google Analytics property. Every event uses `/g/collect`, the transport used by the Google tag.

It measures for Google Analytics only and sends nothing to Meta or other platforms.

You get a second measurement under your own control: a signed cookie set by your server, a consent check on your server, and one Google transport for sessions and purchases. The server checks the consent state the browser reports and cannot confirm it independently, and the data still ends up in Google Analytics. It runs on a small VPS with no database. MIT licensed.

```text
Browser -- regular Google tag / GTM -----------------> regular property (unchanged)
   |
   `-- Vanilla script --> your server --------------> second property
        waits for consent   signed cookie              /g/collect for every event
                            consent check              session flags on the first hit
                            bot filter
                            optional operator verification
```

Use the second property for Vanilla only. Never point it at the property your regular tag uses: nothing deduplicates the two streams. This provides a parallel comparison while keeping the regular tag available. Accept the maintenance risk of the undocumented `/g/collect` endpoint only if that comparison is useful to you; this project has not established an accuracy advantage over sGTM or independent analytics.

## Quick start

You need a domain, a Google Analytics account and an Ubuntu or Debian VPS. [INSTALL.md](INSTALL.md) walks through each step without assuming server experience.

```sh
git clone https://github.com/Narrativva-Labs/vanilla-server-side.git
cd vanilla-server-side
./install.sh
```

Then add the one script tag the installer prints:

```html
<script async src="https://kx7qpa.example.com/s.js"></script>
```

Page views then work by themselves. Other events are read from `dataLayer`, not from GTM tags, so they must already carry their GA4 names and parameters there.

## Try it first

No account and no server. Use Node 22.12+ within 22.x, 24.x, or 26+ (the package engine range); the Docker image and development commands use Node 26. After `npm ci` it runs offline.

```sh
npm ci
npm run demo
```

Open http://localhost:3210. The page has a small consent bar (accept, reject, withdraw) and buttons for `page_view`, `generate_lead` and `purchase`. The real tracker and collector run, with Google replaced by a local stub. The terminal shows what would go to Google and what was blocked.

## Consent

| Visitor | What happens |
| --- | --- |
| Analytics granted | Send |
| No decision yet | Full events wait in memory until a grant; refusal or leaving drops them. A readable undecided banner or Google `default` denied sends a cookieless ping for each allowed event. No signal at all sends nothing |
| Analytics denied | Refusal clears full events and deletes the cookie. The automatic page view and each allowed event send cookieless pings, unless consent already measured that page |

After consent the identity is a random ID in a signed server cookie, the one first-party `HttpOnly` cookie this project stores. The full visitor IP is passed to Google for geography, including by default in denied pings (`_uip`, configurable below). Visible time before the decision stays in browser memory and leaves only with a grant; a refusal discards it.

With `DENIED_PINGS=on` (default), without analytics consent the automatic `page_view` and every allowed event (including ecommerce and purchases) send cookieless `/g/collect` hits with the effective denied state in `gcs` and `gcd`. A readable supported banner, including an undecided one, sends immediately. A Google `default` denied alone waits its `wait_for_update`, capped at 2 seconds; without that field it sends immediately. No consent signal sends nothing: Vanilla cannot infer a site's consent policy. A page already measured with consent sends no later denied pings.

Pings share a random client/page identity within the page, with a rising hit index. Their session_id is the Unix second of the first ping, not random and not unique across visitors. Group denied pings by batch_page_id, never ga_session_id; check that batch_page_id is present in the export first. They carry sanitized event parameters, items, currency, value, cleaned page URL/path, referrer/UTM values, title, language, screen size, browser `User-Agent` (unless DENIED_PING_USER_AGENT=off) and visitor IP (as `_uip`, unless DENIED_PING_IP changes it). No persistent client identifiers are used. They never carry cookies, `user_data` or click IDs, and never retry. Purchase transaction IDs are deduplicated in page memory. `DENIED_PING_IP=full` (default) forwards the full visitor IP as `_uip`; `truncated` zeros the last IPv4 octet (/24) or keeps only the first 48 IPv6 bits (/48), treating IPv4-mapped IPv6 as IPv4; `off` omits `_uip`, so Google geolocates the collector server. Truncation reduces geographic precision. `DENIED_PING_USER_AGENT=on` (default) forwards the browser User-Agent; `off` sends the fixed neutral `User-Agent: unknown` instead, with no browser/device dimensions from that header. An explicit neutral value prevents native fetch from sending its default `node` User-Agent and reveals no runtime version or server identity. These options affect only `/d`; verification still uses the incoming IP and headers, rate limiting retains the real IP, and labels and deduplication are unchanged. `DENIED_PINGS=off` disables all pings. `page_engagement` is excluded, although the Google tag sends a denied `user_engagement` on exit (captured 2026-11-15); Vanilla's exit hit stays consent-only.

For an undecided visitor, full events still wait in memory even after their pings leave. A grant on the same page releases them with identity and the campaign; refusal drops them. Consent given only on a later page does not bring back the landing page's campaign, for the Google tag either. This intentional duplication in raw BigQuery data can be separated with `WHERE privacy_info.analytics_storage = 'Yes'` for full events or `= 'No'` for pings. Tests: `tests/denied-events.test.ts`, `tests/collect.test.ts`. On the live demo on 2026-11-15, Realtime showed only the 5 purchases sent with consent, not the 4 denied purchase pings, so pings did not add to that report. In BigQuery the pings were stored without a visitor ID, with `privacy_info.analytics_storage = 'No'` and the visitor's country (2026-11-15). Standard reports and modeling: **Not verified**.

### Compared with the Google tag

**Denied pings send nothing that the Google tag itself would not send in Advanced Consent Mode, with one exception: the two traffic labels below.** Compared field by field with captured `gtag.js` denied pings (2026-11-15, [Denied event sequence](docs/measurement-protocol-notes.md#denied-event-sequence)):

| Data | Google tag, consent denied (Advanced Consent Mode) | Vanilla denied ping |
| --- | --- | --- |
| page_view and events, incl. items, value, currency, transaction ID | Sent | Same |
| Page URL, title, language, screen size | Sent, URL including `gclid` | Same, but click IDs are removed from URLs |
| Browser User-Agent | Sent by the browser | Same (or `unknown` with `DENIED_PING_USER_AGENT=off`) |
| Visitor IP | Google sees it from the browser connection | Forwarded as `_uip` so geography is the visitor's (or truncated/omitted, see `DENIED_PING_IP`) |
| Page-only random client/session IDs, consent state `gcs`/`gcd` | Sent | Same |
| Exit engagement | Denied `user_engagement` | Not sent |
| `vv_type`, `vv_detail` | Not sent | **Sent** (see below) |

The two labels classify the hit, not the person: `vv_type` is one of `pending`, `human`, `bot_suspicious`, `agent_unverified`, `bot_automation`, `crawler_verified`, `agent_verified`, `bot_spoofed`; `vv_detail` is `operator|verification|purpose|claim|browser_class|phase`, for example `openai|signature_valid|user_directed|signature_agent|human|initial` or `none|no_signature|unknown|none|-|-`. They contain no identifier, IP, cookie or URL. The other difference is the route: the hits pass through your collector, so your server (and whoever operates it for you) also processes the IP and the hit data.

**Basic Consent Mode:** if the site blocks the Google tag until consent, Google normally receives nothing before a decision. Vanilla's default pings would then send more than your Google tag does. Set `DENIED_PINGS=off` on such sites.

URL paths, UTM values, titles and custom event parameters can contain personal data. Disclose the event parameters and visitor IP sent in pings in your privacy notice. "Cookieless" does not mean anonymous.

Supported out of the box:

- direct `gtag("consent", ...)` commands
- [Cookiebot](https://www.cookiebot.com/)
- [CookieConsent by Orest Bida](https://github.com/orestbida/cookieconsent)
- [CookieYes](https://www.cookieyes.com/)
- the built-in Shoptet cookie bar

The tracker reads these banners by itself, without integration code, and a decided banner beats Google's default consent. The conditions: custom CookieConsent categories need attributes on the script tag, a Google `update` already on the page is not overridden by the banner's state at load, and consent held only inside Google Tag Manager cannot be read. See [connecting your banner](INSTALL.md#connect-your-consent-banner) and [what banners really send](docs/cookie-banners.md).

## Google Ads

The server talks only to Google Analytics. Google Ads reaches the data the usual way: link the second property to Ads and import its approved purchase key events as conversions. For that, the landing page's `gclid`, `gbraid` or `wbraid` goes to Google in the first hit, and only when `ad_storage` and `ad_user_data` are both granted. Without them the click ID stays in the browser.

If the regular property already imports the same conversion, set this one as secondary, or it counts twice. A conversion credited to a real ad click: Not verified yet. Steps are in [INSTALL.md](INSTALL.md#optional-import-conversions-into-google-ads).


Do not import leads from the second property into Google Ads: importing key events
also imports leads from agents and automation. Send qualified leads from the backend/CRM
using [offline conversion import](https://support.google.com/google-ads/answer/2998031)
or [enhanced conversions for leads](https://support.google.com/google-ads/answer/11021502).
GA4's UI rules are calculated client-side and do not apply to Vanilla's server-to-server
hits ([GA4 limits](https://support.google.com/analytics/answer/10085872)). Settled purchases
remain eligible under the [conversion guidance](https://github.com/Narrativva-Labs/visitor-verdict/blob/phase2-verifier/docs/conversion-guidance.md);
backend payment/fraud checks still apply.

## Limits

- **Tested on small sites.** Real traffic so far comes from two small sites. On the online store, both properties recorded 15 consented visitors, 17 sessions and 37 page views in BigQuery on 2026-11-14, with small differences in some other slices; on the company website a difference between the two exposed a broken GTM consent setup. A busy site: Not verified. What is better, the same and worse than the Google tag: [verification](docs/verification.md#better-same-and-worse-than-the-google-tag).
- **Reporting can differ from the regular tag.** In the November 7–8 comparison, collect kept all tested hits in the attributed session; mixed transport lost attribution on some MP events. See the [test notes](docs/measurement-protocol-notes.md#all-collect-comparison).
- **`/g/collect` has no public contract.** Google can change it without notice, and it returns 204 for anything. The fields follow captured Google tag hits, so they need a recheck over time. See the [notes](docs/measurement-protocol-notes.md#gcollect).
- **Safari kept the cookie for 7 days in the one run measured.** Safari 26.6.2 stored it for 7.0 days with the tracker on a different IPv4 /16 from the website, the case [WebKit's cap](https://webkit.org/blog/15697/private-browsing-2-0/) describes. A default install runs on a different server, so expect the same. In a return after 8 days the cookie had expired, so Vanilla counted a new user while the regular Google tag counted a returning one. The server renews the cookie on each delivered event; whether that keeps the identity for a visitor who returns within 7 days: Not verified. [Details](docs/technical-overview.md#safari).
- **Content blockers.** Getting past them is a side benefit, not the purpose of this project. A neutral random subdomain and neutral paths lower the chance of a filter list match, but guarantee nothing: first-party does not mean unblockable. In one run, uBlock Origin Lite with default lists did not stop the tracker. Consent rules stay the same: full events require consent, and a refusal stops regular measurement, apart from cookieless event pings. [Details](docs/technical-overview.md#content-blockers)
- **Bots.** A short User-Agent filter drops obvious bots before optional [operator verification](#ai-agent-verification-optional). Non-JavaScript fetchers never run the tracker. Browser-looking automation can pass; a missing signature does not establish humanity.
- **Google accepts at most 16 KiB of event data in one hit, about 130 items.** Like the Google tag, a long event goes in the request body. Above 16 KiB Google refuses the hit (HTTP 413), and the Google tag loses the whole purchase. Vanilla leaves out the last items instead and logs how many, so revenue, transaction ID and the conversion arrive; the item reports miss those items. Raw JSON payloads over 64 KiB are dropped by the browser (or rejected by the collector for direct requests) before the 16 KiB item trimmer; this does not guarantee delivery of arbitrary oversized events.
- **No cross-domain identity, durable queue or backfill.** If your server is down, its events are lost; the regular tag is unaffected.
- **Each open tab keeps its own consent state** until it reloads, so a refusal in one tab does not stop a second open tab at once.
- **Property settings for sessions are not read.** Vanilla ends a session after 30 idle minutes and counts it as engaged after more than 10 seconds of engagement, the defaults of the Google tag. A property with a changed session timeout or engaged-session timer differs from its regular tag. [Details](docs/decisions.md#engaged-sessions-follow-the-google-tag)
- **HTTP 2xx proves delivery only.** Google [does not report errors](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference) on the live endpoint.
- **No legal guarantee.** Choose consent behavior and disclosures that fit your site.

## Links

Related: [Visitor Verdict](https://github.com/Narrativva-Labs/visitor-verdict) — browser traffic classification and optional server verification.

- [INSTALL.md](INSTALL.md): step-by-step setup, consent, verification, updates
- [Technical overview](docs/technical-overview.md): architecture, identity, consent state machine, prior art
- [Measurement Protocol notes](docs/measurement-protocol-notes.md): what the docs say against what the validator and Realtime showed
- [Cookie banners](docs/cookie-banners.md): what consent banners really send
- [Design decisions](docs/decisions.md): each decision with its alternative and source
- [Verification](docs/verification.md): what is tested against real Google Analytics, how, and what is still open

For development on Node 26: `npm ci && npm test && npm run typecheck && npm run build`. `npx playwright install chromium webkit && npm run test:e2e` runs the consent flow in real browsers. `tests/fuzz.test.ts` runs random sequences against rules that must always hold.

Want to change something? See [CONTRIBUTING.md](CONTRIBUTING.md). Found a security issue? See [SECURITY.md](SECURITY.md).

## AI agent verification (optional)

`AGENT_VERIFICATION=on` adds verified operator evidence to `/e` and `/d`; default off.
GA4 receives only two classification event parameters: `vv_type` and `vv_detail`,
on every eligible event, even with verification off and no browser detector.
Without either source they start as `pending` / `none|-|-|-|-|-`. Labels count
toward the 25-parameter limit after automatic/ecommerce fields and before custom
site parameters; budget limits can remove them before delivery.
It labels traffic without routing conversions. **unverified ≠ human**.
Only JavaScript-executing visitors that pass the obvious-bot filter reach this path;
`bot`/`crawl`/`spider` and `HeadlessChrome` UAs are dropped first, including the full
ChatGPT-User UA with its `openai.com/bot` URL. Reverse DNS is disabled.

Use `/health` → `agentVerification.counters` to **measure your own share of verified agents and bots**.
It keeps anonymous integer totals in memory since process start (`since`, ISO UTC),
with separate `events` and `pings` groups. Each has `total`, `byType` (all eight
`vv_type` values), `byVerification`, and overlapping `evidence` counts for signature
headers, known UA claim tokens and non-human browser classes. No visitor data is
retained in these counters; restart resets them. They count labelled hits, including
Google delivery failures and repeated labelled delivery attempts, rather than unique
visitors or successful deliveries. Rejected, duplicate and obvious-bot-filtered hits
are excluded. Browser labels and evidence presence remain measurable with verification
off. See [counter definitions](INSTALL.md#anonymous-hit-counters) before comparing shares.

Register both as **event-scoped custom dimensions**. `vv_type` is human, pending,
agent_verified, agent_unverified, crawler_verified, bot_automation, bot_suspicious or
bot_spoofed. Verified unknown purpose maps to agent_verified with unknown retained in vv_detail; no user-directed role is inferred.
`vv_detail` is `operator|verification|purpose|claim|browser_class|browser_phase`,
maximum 100 characters, missing parts `-`, unknown operator `none`.
Example: `openai|signature_valid|user_directed|signature_agent|human|final`.
The [complete dictionary](INSTALL.md#analyst-value-dictionary) explains every segment,
priority and session rank. Strongest type and known operator stick immediately to
later hits in a bounded memory-only session (denied pings: page only); no delays.

| Browser input without stronger server evidence | vv_type |
|---|---|
| human | human |
| suspicious | bot_suspicious |
| automated | bot_automation |
| declared_agent | agent_unverified |
| none / missing | pending |

GTM-only sites keep traffic_class for now.

A detector loaded after Vanilla (for example from GTM) can miss the first hit, which then stays
`pending`. Opt in with `data-vv-wait-ms="1000"` on the script tag to hold the first hits until the
detector's initial class or at most that many milliseconds; default 0, no wait
([trade-off](INSTALL.md#waiting-for-the-first-class)).

In GA4 use **begins with** `agent_` or `bot_` on vv_type; use **begins with** `openai|`
on vv_detail for OpenAI. Looker Studio operator dimension:
`REGEXP_EXTRACT(vv_detail, '^([^|]+)')`. Data API names are `customEvent:vv_type`
and `customEvent:vv_detail`. The old six field names are no longer forwarded.

Live signature capture and end-to-end verification have been confirmed only for
the ChatGPT agent (OpenAI). On one demo shop on 2026-11-20, one header-capture run
produced 32 signed requests, all verified against the operator key directory.
GA4 Realtime showed `signature_valid` on 5/5 `view_cart` events after cache warming
(1/5 before); only 1/5 had a browser class because early events preceded detection.
This is one operator on one site, not a coverage estimate. Standard reports,
BigQuery and advertising attribution for these agent events are unverified.
The [field observations](https://github.com/Narrativva-Labs/visitor-verdict/blob/phase2-verifier/research/agents-and-tells.md#field-observations-v10-2026-11-19)
include five badge runs across personal and business accounts, an unsigned masked-headless
negative control and two unsigned Grok runs; these are separate samples.

Other registry entries offer uncaptured signature configurations, IP/SAIL evidence,
inactive rDNS rules or claims only. Registry size is not measured coverage.
See [operator capabilities](INSTALL.md#operator-capabilities),
[setup, health and egress](INSTALL.md#enable-in-five-steps),
[optional browser-class setup](INSTALL.md#visitor-verdict-browser-class-optional)
and the [analyst value dictionary](INSTALL.md#analyst-value-dictionary).

Runtime dependencies are Fastify and the vendored `visitor-verdict-server` package;
the latter depends on `structured-headers`. There is no database.

Need this set up, or your measurement reviewed? I do that as paid work: [frantisekbujnovsky.com](https://frantisekbujnovsky.com).
