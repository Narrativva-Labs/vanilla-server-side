# Verification

Author: František Bujnovský.

What has been checked against real Google Analytics, how, and what is still open. The details behind each row live in the linked notes; this page is the index and the method.

Source labels are the same as in the [Measurement Protocol notes](measurement-protocol-notes.md): **Tested** means a manual check with a date and a method, **Not verified** means this project has not confirmed it. Unit and browser tests in `tests/` are listed where they back a row.

## How the tests are run

**Test visits.** Every scenario gets its own `utm_campaign` (for example `demo-buy-1`, `demo-lead-2`) and the medium `robot`. A visit can then be found by its campaign in every report and in the export, and a lost source shows up as a hit outside its campaign.

**Sites.**

- The author's live website, measured by Vanilla into one property.
- The public [demo shop](https://github.com/Narrativva-Labs/vanilla-demo-shop), where Google Tag Manager with the Google tag and Vanilla measure **the same visits** into two separate properties. This is the direct comparison with the Google tag: same pages, same clicks, same moment.
- Two live sites with real visitors, a small online store (since 2026-11-11) and a company website (since 2026-11-13). Each keeps its regular Google tag in GTM and adds Vanilla into a second property for comparison, and both properties export to BigQuery. On the company website a consent bug in GTM made the two cover different visitors until it was fixed (below).
- Testers' own phones on the demo shop, on mobile data: Chrome, Safari and a private Safari window on iPhone, Messenger on iPhone, and two visits in Android in-app browsers (WebView). Facebook and Instagram on iPhone were not tested.

**Browsers.** Playwright drives headless Chromium, WebKit and Firefox for funnels (product list, product, cart, checkout steps, purchase, lead form, search, contact clicks, refusal). Brave and Ghostery run as installed browsers through Playwright. Safari is a real macOS profile, with cookie lifetimes read from its cookie file.

**The Google tag as reference.** `gtag.js` runs in Chromium with its requests captured and answered locally, so nothing reaches Google. Field names, consent flags, body splitting and engagement time in Vanilla were copied from these captures, not from articles.

**Direct hits.** Single requests built by hand and sent straight to `/g/collect` of a test property probe what Google accepts and stores: body size, text lengths, item fields.

**Reading the results.** Three layers, slowest last:

| Layer | Delay | Use |
| --- | --- | --- |
| Realtime (GA4 Data API) | Minutes | Did the event arrive at all, country, device |
| Standard reports (GA4 Data API, by campaign) | Hours, a day to settle | Sessions, source, channel, New users, key events |
| BigQuery daily export | Next day, sometimes later | Hit level: `user_pseudo_id`, `ga_session_id`, campaign on each event, items. The most detailed layer we read; where it disagrees with the reports, we trust the hit level |

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
7. **Fresh standard reports can show a difference that later disappears.** A day after real phone visits on 2026-11-11, the Data API showed the campaign on all 7 Vanilla sessions but on only 2 of 8 GTM sessions: five under `(data not available)` or `(cross-network)`, one under `(not set)`. It looked like an advantage of Vanilla in in-app browsers. Five days later both the Data API and BigQuery gave both properties the campaign on every session. Compare properties after the data has settled, or in the export.
8. **The Data API can miss single events that BigQuery has.** For 2026-11-15 the Data API showed fewer events than the export in both demo properties: GTM `view_item_list` in one scenario 3 of 6 in the Data API and 6 of 6 in BigQuery, and Vanilla's counts after the change lower in the Data API while equal to before the change in BigQuery. A lower count in the Data API alone is not a loss.
9. **A BigQuery link without an export stream exports nothing.** A link created through the Admin API with no entry in `exportStreams` produced no tables for days, until the web stream was added on 2026-11-16. Check that the link lists the web stream.
10. **A script that closes the page right after an event loses the Google tag's last hit.** In the runs of 2026-11-15 the GTM property missed the final `view_item` and `generate_lead` of every visit, in BigQuery too, and had no row at all for the shortest scenario; Vanilla had them. The likely cause is that the Google tag sends events in batches and Playwright closed the page before the batch left; a capture has not confirmed it. On the real visitors of the online store the two properties matched, so such runs do not compare the last event of the two tags.

## What is verified

| Area | Result | Tested | How | Details |
| --- | --- | --- | --- | --- |
| Session source | Every event through `/g/collect` gives source, medium, campaign, channel and New users. Measurement Protocol alone gave `(not set)` in 70 of 70 sessions | 2026-11-06, 2026-11-08 | Data API by campaign | [/g/collect](measurement-protocol-notes.md#gcollect), [comparison](measurement-protocol-notes.md#all-collect-comparison) |
| Identity and sessions | Every hit sent with consent carried `user_pseudo_id` and `ga_session_id`: 6,244 of 6,244, checked hit by hit. Test visits kept their campaign in `session_traffic_source_last_click`, with the two demo exceptions in the next row. One session per visitor in single-visit scenarios, two in the return test | 2026-11-08 to 2026-11-10 | BigQuery, per hit | [Standard reports versus BigQuery](measurement-protocol-notes.md#standard-reports-versus-bigquery) |
| Compared with the Google tag | Same visits, both properties: equal purchases and leads in every run below the rate limit, and `(not set)` in standard reports on both sides. Exceptions in the export: the GTM property lost the campaign of one whole visit; Vanilla created 5 extra visitors from exit hits that arrived without a cookie, fixed on 2026-11-11. Page view counts differ by setup: the demo's GTM has page changes off and sends no limited ping once consent follows | 2026-11-10 | BigQuery, both properties | Same section |
| Limited pings | Stored as `page_view`, `session_start` and `first_visit` without `user_pseudo_id`, also on the landing page of a visitor who accepted after 2 seconds: 256 in the demo export of 2026-11-10. Event counts per campaign include them; visitor and session counts do not | 2026-11-10 | BigQuery | [Limited pings](decisions.md#limited-pings-without-consent) |
| A ping for every event | Since the change of 2026-11-15, export of that day, refusal and an undecided banner send a ping for each allowed event, on the demo shop, the author's website and the company website. In BigQuery every ping has `privacy_info.analytics_storage = 'No'`, no `user_pseudo_id` and its own `first_visit` and `session_start`. The 5 purchase pings of the demo shop carry value, transaction ID and items; `generate_lead` pings 2 of 2. Country from `_uip`: Czechia on every tested ping after the change; three pings before it were placed in Germany, not where the visitor was. In one Realtime check the 4 purchase pings sent until then did not appear, while 5 full purchases did | 2026-11-15, read 2026-11-16 and 17 | Capture, Realtime, BigQuery | Same decision |
| Returning visitor | A return after 31 minutes starts a second session with `ga_session_number` 2, in Chromium and WebKit; the Google tag also counted two sessions | 2026-11-10 | BigQuery | |
| Engaged sessions | 12 of 12 in both demo properties, in visits of several pages. On 2026-11-15 five scenarios ran six times each, before and after the version in which `seg` follows the session went live at 00:03: Vanilla's engaged sessions in BigQuery were the same for both versions, 6 of 6 for three events 6 s apart, a 12 s wait and two pages, 0 of 6 for a lead after 1 s and a short visit. The change aligns the hits with the Google tag; in these scenarios it moved no count, which does not show its effect in general | 2026-11-08, 2026-11-15 | Data API, BigQuery | [Engaged sessions](measurement-protocol-notes.md#engaged-sessions) |
| Consent flow | No decision: event pings leave, full events wait, no cookie. Accept: page view and `HttpOnly` cookie. Reject: deletion request, event pings, no full event, no cookie. Withdraw: cookie deleted, events stop | 2026-11-05, updated 2026-11-15; every push | E2E in Chromium and WebKit | [Real browsers](technical-overview.md#real-browsers) |
| Real banners | Cookiebot, the CookieYes WordPress plugin and Shoptet accepted and refused on live sites; CookieConsent by Orest Bida by automated tests only | 2026-11-05 | Live sites, `tests/cmp-adapters.test.ts` | [Cookie banners](cookie-banners.md) |
| Events before consent | They wait and go out after a grant: `view_item_list` on the landing page 4 of 4 after the change, 0 of 4 before | 2026-11-08 | Demo shop, Data API | [Unknown is not denied](decisions.md#unknown-is-not-denied) |
| Consent on a later page | A visitor who lands with a campaign, decides nothing and accepts only on the next page loses the campaign in both properties: 6 of 6 sessions `(direct)` in GTM and in Vanilla, purchases equal. The next page's address no longer has the UTM parameters, and events wait only within their page | 2026-11-12, 2026-11-15 | Demo shop, Data API, BigQuery | |
| Time before consent | Counted as the Google tag counts it (captured `_et=8057` after 8 s); a 6 s wait shows as 6 s in the report | 2026-11-10 | Capture, Data API | Same decision |
| Purchases | Value, currency, transaction ID and items arrive; `~` in item text escaped as `~~` like the Google tag | 2026-11-09 | Data API, capture | [Collect wire format](measurement-protocol-notes.md#collect-wire-format) |
| Large purchases | Google refuses event data over 16 KiB (about 130 items). The Google tag lost purchases of 160 and 200 items; Vanilla's arrived with full revenue and the first 140 items; current raw JSON limit is 64 KiB before trimming | 2026-11-10, export 2026-11-11 | Direct hits, live tags, BigQuery | Same section |
| Text lengths | Google stores text parameters and item fields cut to 100 characters; `dl` 499, `dr` 420 and `dt` 400 characters kept whole | Export 2026-11-11 | Direct hits, BigQuery | [Stored lengths](measurement-protocol-notes.md#stored-lengths) |
| Vanilla's own 100-character cut | Coupon of 130, item name of 176 and item brand of 140 characters sent through the tracker: Vanilla cut each to 100 and the export stores exactly 100, on both purchases of the run, with the campaign kept | Sent 2026-11-11, export 2026-11-11 | Live site, BigQuery | [Stored lengths](measurement-protocol-notes.md#stored-lengths) |
| Session length (Google tag) | A session started 25 or 49 hours earlier, last hit 1 minute before, kept its `sid` and `sct` and got no `_ss`; 31 idle minutes started a new one. No maximum length | 2026-11-14 | Capture, cookies set by hand | [Session length](measurement-protocol-notes.md#session-length) |
| Engaged-session flag (Google tag) | `seg=1` after a later page view or more than 10 s of engagement summed over the session, kept for the session in the cookie. Three hits 6 s apart on one page: `0`, `1`, `1`. `generate_lead` and `purchase` alone: `0` | 2026-11-14 | Capture | [Engaged sessions](measurement-protocol-notes.md#engaged-sessions) |
| Page changes | `pushState`, `replaceState` and fragment changes count as the Google tag with enhanced measurement counts them | 2026-11-10 | Capture | [History changes](measurement-protocol-notes.md#history-changes) |
| Load | 14 visits at once from one address: the same ecommerce events per visit as without load and 6 of 6 purchases; one visit had one more `page_engagement`. 28 at once: losses from the rate limit only, the Google tag 12 of 12 | 2026-11-10, export 2026-11-11 | Demo shop, BigQuery | [Standard reports versus BigQuery](measurement-protocol-notes.md#standard-reports-versus-bigquery) |
| Tracker server down | With `async` the page and its banner are not held; with `defer` an unanswered address held them for 75 s | 2026-11-10 | Chromium, live site | [Browser checks](measurement-protocol-notes.md#browser-checks) |
| Geography | Country comes from `_uip`, not from the sending machine, for full hits and pings | 2026-11-06, 2026-11-15 | Realtime, BigQuery | [/g/collect](measurement-protocol-notes.md#gcollect) |
| Content blockers | No list of 12 filter lists and 5 DNS lists matched the tracker; 4 and 4 matched the Google tag. Brave Shields and Ghostery let the tracker through; Ghostery refuses banners by itself, so only the limited ping goes | 2026-11-05, 2026-11-10 | adblock-rust, installed browsers | [Browser checks](measurement-protocol-notes.md#browser-checks) |
| Safari | The server-set cookie was stored for 7.0 days with the tracker on a different IPv4 /16 | 2026-11-05 | Real Safari, one run | [Safari](technical-overview.md#safari) |
| Safari, return after 8 days | The expired cookie made Vanilla count a new user; the Google tag kept `_ga` and counted a returning user | 2026-11-13 | Real Safari, one run | [Safari](technical-overview.md#safari) |
| Install on a clean server | First install, a second run that keeps .env, and an update, each followed by checks of .env, both containers, HTTPS `/health` and compressed `s.js`, on x86 and ARM. A minimal Ubuntu 24.04 on ARM without git or Docker, in a local container, went through INSTALL.md up to `docker compose up`: git, clone, the three questions, Docker from Docker's repository started by systemd, the DNS check. The build then failed on the container's nested file system, so it is not a completed installation. A real certificate and public DNS are not part of either | Pushes to main and manual runs; ARM since 2026-11-17 | CI, local container | [INSTALL.md](../INSTALL.md#5-install) |
| Live security answers | Other or missing `Origin` 403, malformed JSON 400, 70 KiB body 413, file paths 404 or 400, CORS preflight only for the site origin, cookie `HttpOnly`, `Secure`, `SameSite=Lax` | 2026-11-10 | `curl` against a live install | |
| Compression | `s.js` goes out at 6.8 KB instead of 16.3 KB | 2026-11-10 | Live install | |
| Real visitors, online store | The same real visits with consent in both properties: 15 visitors, 17 sessions and 37 page views in each on 2026-11-14, no hit without a session ID. From 2026-11-12 to 15, split by operating system and browser, the counts were equal apart from one group with 17 page views in the regular property and 19 in Vanilla's. iOS Safari: 6 sessions and 9 page views in each. Too few orders to compare purchases | 2026-11-12 to 15 | BigQuery, both properties | |
| Real visitors, company website | The regular tag was broken by the site's Content Security Policy: without `'unsafe-eval'` GTM's Custom JavaScript variables did not run, so no consent default was set, undecided visitors were measured in full and consenting ones only as denied hits. Vanilla reads the banner itself and measured consenting visitors as expected: 147 full page views on 2026-11-14 against 148 denied page views in the regular property. Fixed in GTM on 2026-11-15. The older Vanilla sent nothing for undecided visitors there, because no Google default was set; since 2026-11-15 a readable undecided banner is enough for pings | 2026-11-14 to 15 | Capture, BigQuery | |
| Real iPhones | First tester, iPhone with iOS 26.3, Safari settings reported as default but not checked, 2026-11-14: Vanilla recorded 3 of 3 visits with their purchases (Safari, a private window, Messenger), the Google tag only the Messenger visit; the cause is unknown. Second tester, default Safari, 2026-11-16: both recorded the full funnel and the purchase, in Safari and in a private window; one earlier private-window attempt lost cart and purchase in both. With the online store's iOS Safari visits equal, this shows no general Safari advantage | 2026-11-14, 2026-11-16 | BigQuery, Realtime | |
| In-app browsers | Two real visits in Android in-app browsers (WebView), one with a purchase, and one through Messenger on iPhone: both properties kept the campaign on every session and recorded the same purchases | 2026-11-11, 2026-11-14 | BigQuery | |

## Better, same and worse than the Google tag

What the rows above show when the same visits are measured by both. The direct comparisons are the demo shop, the online store and the testers' phones.

**Better in Vanilla**

- **Large purchases.** Purchases of 160 and 200 items went over Google's 16 KiB body limit: the Google tag lost them whole, Vanilla kept full revenue, transaction ID and the first 140 items. Raw JSON payloads over 64 KiB are dropped by the browser (or rejected by the collector for direct requests) before the 16 KiB item trimmer; this does not guarantee delivery of arbitrary oversized events.
- **Filter lists.** None of 12 filter lists and 5 DNS lists matched the tracker; 4 and 4 matched the Google tag. This is a side effect of the setup, not a way around consent.
- **A second check of consent.** On the company website a broken GTM setup measured undecided visitors in full; Vanilla read the banner itself and stayed correct. A difference between the two properties is how the error was found.

**The same**

- Consented visitors, sessions and page views of real visitors on the online store, in BigQuery, with the small differences listed above. Purchases there: too few to compare.
- Campaign and purchases in the in-app browsers tested, in BigQuery.
- Safari on iPhone in the online store's real visits and in the second tester's funnels, including a private window. The first tester's two Safari purchases appeared only in Vanilla, for an unknown reason.
- `(not set)` in standard reports for some later hits, in both properties, while the export is complete.
- The campaign is lost in both when consent comes only on a later page.

**Worse in Vanilla**

- **Safari after 7 days, in one run.** Safari capped Vanilla's cookie at 7 days, so a visitor returning after 8 days was a new user in Vanilla and a returning one for the Google tag.
- **Many visitors behind one address.** The per-address limit cost test funnels events before it was raised on 2026-11-12; a busy site behind a shared address is Not verified.
- **Its own server.** Downtime can lose events: the browser retries a few times, but there is no durable queue or backfill. The Google tag does not depend on it.
- **Property settings.** A changed session timeout or engaged-session timer in the property is not read.
- **Bots.** Only a short User-Agent filter; Google's own bot exclusion for these hits is Not verified.

## Not verified yet

- **A real Google Ads click.** Whether the session shows the Ads campaign (`sessionGoogleAdsCampaignName`, not only `google / cpc`) and whether a conversion imported through the GA4 link is credited. An invented `gclid` gave `google / organic`, which proves nothing.
- **Text lengths in standard reports**, as opposed to the export.
- **Sessions longer than 24 hours** in GA4 reports. The captures show only that the Google tag keeps them.
- **Denied pings in standard reports and in modeling.** BigQuery stores them; in one Realtime check purchase pings did not appear.
- **Known bot exclusion** for these hits.
- **Instagram and Facebook in-app browsers on iPhone.** Android WebView and Messenger on iPhone: a handful of real visits, equal in both properties.
- **Busy sites.** Real traffic so far comes from two small sites, on days with low visitor counts. Many real visitors behind one shared address (mobile carriers, offices) were not part of any test.
- **The default proxy under live traffic.** The live installs used for testing run behind nginx instead of the default Caddy. The installer and Caddy are checked in CI with a test certificate, so a real Let's Encrypt certificate through the installer has not been part of a test.
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
