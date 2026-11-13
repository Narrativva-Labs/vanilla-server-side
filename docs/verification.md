# Verification

Author: František Bujnovský.

What has been checked against real Google Analytics, how, and what is still open. The details behind each row live in the linked notes; this page is the index and the method.

Source labels are the same as in the [Measurement Protocol notes](measurement-protocol-notes.md): **Tested** means a manual check with a date and a method, **Not verified** means this project has not confirmed it. Unit and browser tests in `tests/` are listed where they back a row.

## How the tests are run

**Test visits.** Every scenario gets its own `utm_campaign` (for example `demo-buy-1`, `demo-lead-2`) and the medium `robot`. A visit can then be found by its campaign in every report and in the export, and a lost source shows up as a hit outside its campaign.

**Two sites.**

- The author's live website, measured by Vanilla into one property.
- The public [demo shop](https://github.com/Narrativva-Labs/vanilla-demo-shop), where Google Tag Manager with the Google tag and Vanilla measure **the same visits** into two separate properties. This is the direct comparison with the Google tag: same pages, same clicks, same moment.

**Browsers.** Playwright drives headless Chromium, WebKit and Firefox for funnels (product list, product, cart, checkout steps, purchase, lead form, search, contact clicks, refusal). Brave and Ghostery run as installed browsers through Playwright. Safari is a real macOS profile, with cookie lifetimes read from its cookie file.

**The Google tag as reference.** `gtag.js` runs in Chromium with its requests captured and answered locally, so nothing reaches Google. Field names, consent flags, body splitting and engagement time in Vanilla were copied from these captures, not from articles.

**Direct hits.** Single requests built by hand and sent straight to `/g/collect` of a test property probe what Google accepts and stores: body size, text lengths, item fields.

**Reading the results.** Three layers, slowest last:

| Layer | Delay | Use |
| --- | --- | --- |
| Realtime (GA4 Data API) | Minutes | Did the event arrive at all, country, device |
| Standard reports (GA4 Data API, by campaign) | Hours, a day to settle | Sessions, source, channel, New users, key events |
| BigQuery daily export | Next day, sometimes later | Hit level: `user_pseudo_id`, `ga_session_id`, campaign on each event, items. The final word |

On the server, `LOG_EVENTS=on` writes what left it and what Google answered, without visitor details. HTTP 204 from Google proves delivery only.

**Filter lists.** The lists are downloaded on the day and matched with the `adblock` (adblock-rust) engine against the tracker's and the Google tag's URLs, without a browser.

## Traps met while testing

These cost time once. Each looked like a measurement bug and was not.

1. **Headless Chromium can label itself a bot.** With the User-Agent set only on the Playwright context, requests sent with `keepalive` after leaving a page went out as `HeadlessChrome`. The server filtered them as bots, and GA4 most likely does too, so checkout steps looked lost for both tags. Set the User-Agent in the launch arguments as well (`--user-agent=…`).
2. **Request capture misses beacons sent while leaving a page.** In Chromium, Playwright did not see the Google tag's last hits before navigation, so GTM seemed to lose checkout steps. The export decides, not the capture.
3. **Many visitors from one address hit the rate limit.** With 300 requests a minute and 30 simultaneous deliveries per IP, 28 parallel test visits got 429 answers and, after three tries, lost the ends of their funnels; 14 got none. Real visitors usually come from different addresses, but a mobile carrier or an office network can put many of them behind one. Since 2026-11-12 the collector allows 1,200 requests a minute and 100 simultaneous deliveries per IP, 300 in total; the same 28 parallel visits then got no 429, and the collector accepted 28 of 28 purchases. Whether the limit still costs a busy site events is Not verified.
4. **`(not set)` in standard reports is not a sending problem.** Later hits of a visit sometimes appear under `(not set)` as a separate user without `first_visit`. The export showed the right session and campaign on every one of them, and the Google tag got the same in the demo shop. See [standard reports versus BigQuery](measurement-protocol-notes.md#standard-reports-versus-bigquery).
5. **A BigQuery link made through the Admin API exports nothing at first.** The export started only after the service account `firebase-measurement@system.gserviceaccount.com` got the BigQuery User role in the Cloud project; linking through the API did not add it. The first tables then came one to two days later, Google filled in one or two earlier days, and one earlier day of a new property had still not arrived two days later.
6. **A restart clears what the server keeps in memory**: recent withdrawals and event IDs for deduplication. Tests right after a restart are valid, but do not retry the same event across one.

## What is verified

| Area | Result | Tested | How | Details |
| --- | --- | --- | --- | --- |
| Session source | Every event through `/g/collect` gives source, medium, campaign, channel and New users. Measurement Protocol alone gave `(not set)` in 70 of 70 sessions | 2026-11-06, 2026-11-08 | Data API by campaign | [/g/collect](measurement-protocol-notes.md#gcollect), [comparison](measurement-protocol-notes.md#all-collect-comparison) |
| Identity and sessions | Every hit sent with consent carried `user_pseudo_id` and `ga_session_id`: 6,244 of 6,244, checked hit by hit. Test visits kept their campaign in `session_traffic_source_last_click`, with the two demo exceptions in the next row. One session per visitor in single-visit scenarios, two in the return test | 2026-11-08 to 2026-11-10 | BigQuery, per hit | [Standard reports versus BigQuery](measurement-protocol-notes.md#standard-reports-versus-bigquery) |
| Compared with the Google tag | Same visits, both properties: equal purchases and leads in every run below the rate limit, and `(not set)` in standard reports on both sides. Exceptions in the export: the GTM property lost the campaign of one whole visit; Vanilla created 5 extra visitors from exit hits that arrived without a cookie, fixed on 2026-11-11. Page view counts differ by setup: the demo's GTM has page changes off and sends no limited ping once consent follows | 2026-11-10 | BigQuery, both properties | Same section |
| Limited pings | Stored as `page_view`, `session_start` and `first_visit` without `user_pseudo_id`, also on the landing page of a visitor who accepted after 2 seconds: 256 in the demo export of 2026-11-10. Event counts per campaign include them; visitor and session counts do not | 2026-11-10 | BigQuery | [Limited pings](decisions.md#limited-pings-without-consent) |
| Returning visitor | A return after 31 minutes starts a second session with `ga_session_number` 2, in Chromium and WebKit; the Google tag also counted two sessions | 2026-11-10 | BigQuery | |
| Engaged sessions | 12 of 12 in both demo properties, in visits of several pages. Single-page thresholds were not tested on their own | 2026-11-08 | Data API | [Standard reports versus BigQuery](measurement-protocol-notes.md#standard-reports-versus-bigquery) |
| Consent flow | No decision: nothing sent, no cookie. Accept: page view and `HttpOnly` cookie. Reject: deletion request, one limited ping, no event. Withdraw: cookie deleted, events stop | 2026-11-05, every push | E2E in Chromium and WebKit | [Real browsers](technical-overview.md#real-browsers) |
| Real banners | Cookiebot, the CookieYes WordPress plugin and Shoptet accepted and refused on live sites; CookieConsent by Orest Bida by automated tests only | 2026-11-05 | Live sites, `tests/cmp-adapters.test.ts` | [Cookie banners](cookie-banners.md) |
| Events before consent | They wait and go out after a grant: `view_item_list` on the landing page 4 of 4 after the change, 0 of 4 before | 2026-11-08 | Demo shop, Data API | [Unknown is not denied](decisions.md#unknown-is-not-denied) |
| Time before consent | Counted as the Google tag counts it (captured `_et=8057` after 8 s); a 6 s wait shows as 6 s in the report | 2026-11-10 | Capture, Data API | Same decision |
| Purchases | Value, currency, transaction ID and items arrive; `~` in item text escaped as `~~` like the Google tag | 2026-11-09 | Data API, capture | [Collect wire format](measurement-protocol-notes.md#collect-wire-format) |
| Large purchases | Google refuses event data over 16 KiB (about 130 items). The Google tag lost purchases of 160 and 200 items; Vanilla's arrived with full revenue and the first 140 items | 2026-11-10, export 2026-11-11 | Direct hits, live tags, BigQuery | Same section |
| Text lengths | Google stores text parameters and item fields cut to 100 characters; `dl` 499, `dr` 420 and `dt` 400 characters kept whole | Export 2026-11-11 | Direct hits, BigQuery | [Stored lengths](measurement-protocol-notes.md#stored-lengths) |
| Page changes | `pushState`, `replaceState` and fragment changes count as the Google tag with enhanced measurement counts them | 2026-11-10 | Capture | [History changes](measurement-protocol-notes.md#history-changes) |
| Load | 14 visits at once from one address: the same ecommerce events per visit as without load and 6 of 6 purchases; one visit had one more `page_engagement`. 28 at once: losses from the rate limit only, the Google tag 12 of 12 | 2026-11-10, export 2026-11-11 | Demo shop, BigQuery | [Standard reports versus BigQuery](measurement-protocol-notes.md#standard-reports-versus-bigquery) |
| Tracker server down | With `async` the page and its banner are not held; with `defer` an unanswered address held them for 75 s | 2026-11-10 | Chromium, live site | [Browser checks](measurement-protocol-notes.md#browser-checks) |
| Geography | Country comes from `_uip`, not from the sending machine | 2026-11-06 | Realtime | [/g/collect](measurement-protocol-notes.md#gcollect) |
| Content blockers | No list of 12 filter lists and 5 DNS lists matched the tracker; 4 and 4 matched the Google tag. Brave Shields and Ghostery let the tracker through; Ghostery refuses banners by itself, so only the limited ping goes | 2026-11-05, 2026-11-10 | adblock-rust, installed browsers | [Browser checks](measurement-protocol-notes.md#browser-checks) |
| Safari | The server-set cookie was stored for 7.0 days with the tracker on a different IPv4 /16 | 2026-11-05 | Real Safari, one run | [Safari](technical-overview.md#safari) |
| Safari, return after 8 days | The expired cookie made Vanilla count a new user; the Google tag kept `_ga` and counted a returning user | 2026-11-13 | Real Safari, one run | [Safari](technical-overview.md#safari) |
| Live security answers | Other or missing `Origin` 403, malformed JSON 400, 70 KiB body 413, file paths 404 or 400, CORS preflight only for the site origin, cookie `HttpOnly`, `Secure`, `SameSite=Lax` | 2026-11-10 | `curl` against a live install | |
| Compression | `s.js` goes out at 6.8 KB instead of 16.3 KB | 2026-11-10 | Live install | |

## Not verified yet

- **A real Google Ads click.** Whether the session shows the Ads campaign (`sessionGoogleAdsCampaignName`, not only `google / cpc`) and whether a conversion imported through the GA4 link is credited. An invented `gclid` gave `google / organic`, which proves nothing.
- **Vanilla's own 100-character cut in the export.** Sent live on 2026-11-11 (coupon 130, item name 176, item brand 140 characters); the export of that day decides.
- **Text lengths in standard reports**, as opposed to the export.
- **Denied pings** in any report or in modeling.
- **Known bot exclusion** for these hits.
- **In-app browsers** of Instagram, Facebook and Messenger, where many ad clicks open. A visit through Messenger on 2026-11-11 is the first data point; a test with more people is planned.
- **Real visitors.** All rows above come from scripted browsers on one machine and one address. Real devices, networks and many visitors behind one shared address (mobile carriers, offices) were not part of any test.
- **The default proxy.** The live installs used for testing run behind nginx instead of the default Caddy; the installer and Caddy are checked in CI, not under live traffic.
- **Safari:** whether a returning visitor keeps the identity after the server renews the cookie, and whether a same-origin proxy avoids the 7-day cap. Safari Advanced Tracking and Fingerprinting Protection.

## Reading the export

One query answers most questions: does every hit of a test campaign keep its visitor, session and campaign?

```sql
SELECT
  session_traffic_source_last_click.manual_campaign.campaign_name AS campaign,
  COUNT(*) AS hits,
  COUNT(DISTINCT user_pseudo_id) AS visitors,
  COUNT(DISTINCT CONCAT(user_pseudo_id, CAST(
    (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'ga_session_id') AS STRING))) AS sessions,
  COUNTIF(event_name = 'purchase') AS purchases
FROM `your-project.analytics_123456789.events_20261110`
GROUP BY campaign
ORDER BY campaign
```

Expect `sessions` equal to `visitors` (two per visitor in a return test). Hits without `user_pseudo_id` are the limited pings sent without consent. Grouping alone can hide a hit that lost its session ID or campaign, so count those separately: hits with `user_pseudo_id` but no `ga_session_id`, hits with `user_pseudo_id` under `(not set)`, and visitors without any `page_view`.
