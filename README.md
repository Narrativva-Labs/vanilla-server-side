# Vanilla Server-Side

**[Install it](INSTALL.md)** | **[Understand how it works](docs/technical-overview.md)**

A small, self-hosted analytics collector by František Bujnovský. Your regular Google Analytics stays exactly as it is. Next to it, a tiny script sends events to your own server, and your server forwards them to a **second, separate** Google Analytics property. Every event uses `/g/collect`, the transport used by the Google tag.

It measures for Google Analytics only and sends nothing to Meta or other platforms.

Need this set up, or your measurement reviewed? I do that as paid work: [frantisekbujnovsky.com](https://frantisekbujnovsky.com).

You get a second measurement under your own control: a signed cookie set by your server, a consent check on your server, and one Google transport for sessions and purchases. The server checks the consent state the browser reports and cannot confirm it independently, and the data still ends up in Google Analytics. It runs on a small VPS with no database. MIT licensed.

```text
Browser -- regular Google tag / GTM -----------------> regular property (unchanged)
   |
   `-- Vanilla script --> your server --------------> second property
        waits for consent   signed cookie              /g/collect for every event
                            consent check              session flags on the first hit
                            bot filter
```

Use the second property for Vanilla only. Never point it at the property your regular tag uses: nothing deduplicates the two streams.

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

No account and no server. It needs Node 22.12, 24 or 26, and after `npm ci` it runs offline.

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

After consent the identity is a random ID in a signed server cookie, the one first-party `HttpOnly` cookie this project stores. The full visitor IP is passed to Google for geography, including in denied pings (`_uip`). Visible time before the decision stays in browser memory and leaves only with a grant; a refusal discards it.

Without analytics consent, the automatic `page_view` and every allowed event (including ecommerce and purchases) send cookieless `/g/collect` hits with the effective denied state in `gcs` and `gcd`. A readable supported banner, including an undecided one, sends immediately. A Google `default` denied alone waits its `wait_for_update`, capped at 2 seconds; without that field it sends immediately. No consent signal sends nothing: Vanilla cannot infer a site's consent policy. A page already measured with consent sends no later denied pings.

Pings share random client and session IDs only within the page, with a rising hit index. They carry sanitized event parameters, items, currency, value, cleaned URL, referrer, title, language, screen size, browser `User-Agent` and visitor IP. They never carry cookies, `user_data` or click IDs, and never retry. Purchase transaction IDs are deduplicated in page memory. `DENIED_PINGS=off` disables all pings. `page_engagement` is excluded, although the Google tag sends a denied `user_engagement` on exit (captured 2026-11-15); Vanilla's exit hit stays consent-only.

For an undecided visitor, full events still wait in memory even after their pings leave. A grant on the same page releases them with identity and the campaign; refusal drops them. Consent given only on a later page does not bring back the landing page's campaign, for the Google tag either. This intentional duplication in raw BigQuery data can be separated with `WHERE privacy_info.analytics_storage = 'Yes'` for full events or `= 'No'` for pings. Tests: `tests/denied-events.test.ts`, `tests/collect.test.ts`. On the live demo on 2026-11-15, Realtime showed only the 5 purchases sent with consent, not the 4 denied purchase pings, so pings did not add to that report. In BigQuery the pings were stored without a visitor ID, with `privacy_info.analytics_storage = 'No'` and the visitor's country (2026-11-15). Standard reports and modeling: **Not verified**.

URL paths, UTM values, titles and custom event parameters can contain personal data. Disclose the event parameters and visitor IP sent in pings in your privacy notice. "Cookieless" does not mean anonymous.

Supported out of the box:

- direct `gtag("consent", ...)` commands
- [Cookiebot](https://www.cookiebot.com/)
- [CookieConsent by Orest Bida](https://github.com/orestbida/cookieconsent)
- [CookieYes](https://www.cookieyes.com/)
- the built-in Shoptet cookie bar

The tracker reads these banners by itself, without integration code, and a decided banner beats Google's default consent. The conditions: custom CookieConsent categories need attributes on the script tag, a Google `update` already on the page is not overridden by the banner's state at load, and consent held only inside Google Tag Manager cannot be read. See [connecting your banner](INSTALL.md#connect-your-consent-banner) and [what banners really send](docs/cookie-banners.md).

## Google Ads

The server talks only to Google Analytics. Google Ads reaches the data the usual way: link the second property to Ads and import its key events as conversions. For that, the landing page's `gclid`, `gbraid` or `wbraid` goes to Google in the first hit, and only when `ad_storage` and `ad_user_data` are both granted. Without them the click ID stays in the browser.

If the regular property already imports the same conversion, set this one as secondary, or it counts twice. A conversion credited to a real ad click: Not verified yet. Steps are in [INSTALL.md](INSTALL.md#optional-import-conversions-into-google-ads).

## Limits

- **Tested on small sites.** Real traffic so far comes from two small sites. On the online store the consented visitors, sessions and page views of both properties matched in BigQuery on 2026-11-14, with small differences in some other slices; on the company website a difference between the two exposed a broken GTM consent setup. A busy site: Not verified. What is better, the same and worse than the Google tag: [verification](docs/verification.md#better-same-and-worse-than-the-google-tag).
- **Reporting can differ from the regular tag.** In the November 7–8 comparison, collect kept all tested hits in the attributed session; mixed transport lost attribution on some MP events. See the [test notes](docs/measurement-protocol-notes.md#all-collect-comparison).
- **`/g/collect` has no public contract.** Google can change it without notice, and it returns 204 for anything. The fields follow captured Google tag hits, so they need a recheck over time. See the [notes](docs/measurement-protocol-notes.md#gcollect).
- **Safari kept the cookie for 7 days in the one run measured.** Safari 26.6.2 stored it for 7.0 days with the tracker on a different IPv4 /16 from the website, the case [WebKit's cap](https://webkit.org/blog/15697/private-browsing-2-0/) describes. A default install runs on a different server, so expect the same. In a return after 8 days the cookie had expired, so Vanilla counted a new user while the regular Google tag counted a returning one. The server renews the cookie on each delivered event; whether that keeps the identity for a visitor who returns within 7 days: Not verified. [Details](docs/technical-overview.md#safari).
- **Content blockers.** Getting past them is a side benefit, not the purpose of this project. A neutral random subdomain and neutral paths lower the chance of a filter list match, but guarantee nothing: first-party does not mean unblockable. In one run, uBlock Origin Lite with default lists did not stop the tracker. Consent rules stay the same: full events require consent, and a refusal stops regular measurement, apart from cookieless event pings. [Details](docs/technical-overview.md#content-blockers)
- **Bots.** A short User-Agent filter stops obvious ones. Anything that claims to be a browser passes.
- **Google accepts at most 16 KiB of event data in one hit, about 130 items.** Like the Google tag, a long event goes in the request body. Above 16 KiB Google refuses the hit (HTTP 413), and the Google tag loses the whole purchase. Vanilla leaves out the last items instead and logs how many, so revenue, transaction ID and the conversion arrive; the item reports miss those items.
- **No cross-domain identity, durable queue or backfill.** If your server is down, its events are lost; the regular tag is unaffected.
- **Each open tab keeps its own consent state** until it reloads, so a refusal in one tab does not stop a second open tab at once.
- **Property settings for sessions are not read.** Vanilla ends a session after 30 idle minutes and counts it as engaged after more than 10 seconds of engagement, the defaults of the Google tag. A property with a changed session timeout or engaged-session timer differs from its regular tag. [Details](docs/decisions.md#engaged-sessions-follow-the-google-tag)
- **HTTP 2xx proves delivery only.** Google [does not report errors](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference) on the live endpoint.
- **No legal guarantee.** Choose consent behavior and disclosures that fit your site.

## Links

- [INSTALL.md](INSTALL.md): step-by-step setup, consent, verification, updates
- [Technical overview](docs/technical-overview.md): architecture, identity, consent state machine, prior art
- [Measurement Protocol notes](docs/measurement-protocol-notes.md): what the docs say against what the validator and Realtime showed
- [Cookie banners](docs/cookie-banners.md): what consent banners really send
- [Design decisions](docs/decisions.md): each decision with its alternative and source
- [Verification](docs/verification.md): what is tested against real Google Analytics, how, and what is still open

For development on Node 26: `npm ci && npm test && npm run typecheck && npm run build`. `npx playwright install chromium webkit && npm run test:e2e` runs the consent flow in real browsers. `tests/fuzz.test.ts` runs random sequences against rules that must always hold.

Want to change something? See [CONTRIBUTING.md](CONTRIBUTING.md). Found a security issue? See [SECURITY.md](SECURITY.md).

## AI agent verification (optional)

Set `AGENT_VERIFICATION=on` to add `agent_verification`, `agent_operator`, and
`agent_claim` to full events and denied-consent pings. The default is `off`;
verification then creates no verifier and makes no verification network requests.
`TRACKER_DOMAIN` must contain the external tracker host (for example,
`kx7qpa.example.com`), without a scheme or path.

Visitor Verdict checks signatures and supported operator IP evidence. This only
labels events: verdicts never withhold hits, change consent, or replace the existing
obvious-bot filter. Unsigned traffic is not proof of a human. Verification has a
300 ms deadline; failures or timeouts send the hit without verification fields.
The three server labels take priority over client custom parameters within the
existing 25-parameter limit. When enabled, client values for these names are ignored.

Privacy: the verifier uses the client IP in memory only and exports only three
low-cardinality strings. It fetches public operator key directories and IP lists
from an allowlist and caches public verification material. Reverse DNS is disabled;
request IPs, raw headers, and signature data are never added to analytics by this
feature. Existing Google delivery and geography behavior is unchanged.

In GA4, register these **event-scoped custom dimensions**, using the same names
for the event parameters: `agent_verification`, `agent_operator`, `agent_claim`.
For example, a verified OpenAI signature produces `signature_valid`, `openai`,
and `signature_agent`, respectively; unsigned traffic without operator evidence
produces `no_signature`, `none`, and `none`.
