# Measurement Protocol notes

Where the documentation, the validation server and the reports disagree, and what this project does about it.

Every row has a source:

- **Tested**: manual project checks with date and method. Historical validator results below were recorded before MP was removed; the validation script is retired.
- **Google docs**: the linked page, read on 2026-11-05.
- **Not verified**: not confirmed by this project.

The validator was run against a web data stream. It checks structure, and [Google says](https://developers.google.com/analytics/devguides/collection/protocol/ga4/validating-events) events sent to it do not appear in reports. A validator result is not proof of what the live endpoint does.

## Validation modes matter

[Google docs](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference): `RELAXED` is the default and "only rejects requests that are malformed"; it "ignores parameters that exceed limits". `ENFORCE_RECOMMENDATIONS` rejects them. Google recommends the strict mode while validating and leaving the field out in production.

The retired MP integration omitted `validation_behavior` in production and used `ENFORCE_RECOMMENDATIONS` for validation unless noted.

## Validator results

All rows: Tested, 2026-11-05, the historical MP validator run.

| Claim checked | Documentation | Result |
| --- | --- | --- |
| Payloads built by this repository | | All accepted: `page_view` with device and `ip_override`; `purchase`; `page_engagement`; 5000-character URL, referrer and title after trimming |
| `device.model` | [Reference](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference): optional | Strict: `VALUE_REQUIRED`, "Device model is required." Also rejected when blank. `RELAXED`: accepted |
| `device.browser` | Reference: optional | Strict: `VALUE_REQUIRED`, "Device browser is required." A blank string (one space) is accepted. `RELAXED`: accepted |
| `device` with `category` only | Reference: "We recommend `category` at a minimum" | Strict: rejected. `model` plus `browser` alone: accepted |
| Reserved event names | Reference: 31 reserved, plus `ad_impression`, `in_app_purchase` and `screen_view` for App streams only | Rejected 20 of those 34; accepted 14 (lists below) |
| `user_engagement` | Reference: reserved | Rejected as `NAME_RESERVED`, in strict and in `RELAXED` mode |
| Custom item parameters | [Sending events](https://developers.google.com/analytics/devguides/collection/protocol/ga4/sending-events): "a maximum of 10". [Help Center](https://support.google.com/analytics/answer/9267744): 27, in addition to the prescribed ones | 10 and 11 accepted, so 10 is not enforced. `item_id` plus 26 custom accepted, plus 27 rejected: "at most [27] custom params". Standard fields count too: all 22 documented fields plus 5 custom were accepted 12 of 12 times, plus 15 rejected 12 of 12 times. In between the answer is not stable: the same request with 7 custom was rejected on some repeats and accepted on others. So 27 fields in total is the largest count accepted every time. `RELAXED`: 60 accepted |
| Parameters per event | Reference: 25 | 25 accepted, 26 rejected. `RELAXED`: accepted |
| `page_location` | Help Center: 1,000. Reference: 100 for parameter values | Largest accepted: 256 |
| `page_referrer` | Help Center: 420. Reference: 100 | Largest accepted: 256 |
| `page_title` | Help Center: 300. Reference: 100 | Largest accepted: 256 |
| Other event parameter text, `item_name` | Reference: 100 characters | Largest accepted: 100 |
| Unit of those limits | Docs and the error message say "characters" | The validator counts UTF-8 bytes: 256 ASCII, 128 `č`, 85 `中` or 64 `😀` pass for page fields; 100, 50, 33 or 25 for other text; 100 ASCII or 50 `č` for `item_name` |
| Over-limit text in `RELAXED` | Reference: "ignores parameters that exceed limits" | 2000 characters returned no message. The live collect endpoint cuts it, see [Stored lengths](#stored-lengths) |
| `ip_override` format | Reference: IP address | `192.0.2.1`, `2001:db8::1` and `not-an-ip` all accepted, so the validator does not check it |

Reserved names, as answered by the validator:

- Rejected: `ad_activeview ad_click ad_exposure ad_query adunit_exposure app_clear_data app_install app_remove app_update error first_open first_visit notification_dismiss notification_foreground notification_open notification_receive os_update session_start user_engagement in_app_purchase`
- Accepted: `ad_reward app_exception app_store_refund app_upgrade dynamic_link_app_open dynamic_link_app_update dynamic_link_first_open firebase_campaign firebase_in_app_message_action firebase_in_app_message_dismiss firebase_in_app_message_impression notification_send ad_impression screen_view`

## Current parameter limits

The collect serializer retains the previous validator limits: 25 parameters including automatic fields, 200 items, standard item fields plus 27 custom fields, other strings cut to their first 100 characters as Google stores them, and page text trimmed to 256 UTF-8 bytes inside event parameters. `dl` and `dr` keep 1000 bytes and `dt` 300 on every hit, so long campaign values survive. Names and engagement values are checked before serialization. The other limits are conservative local ones, not a new measurement of collect's acceptance. Browser/model fields belonged to the retired MP body; collect forwards the browser User-Agent instead. `page_engagement` remains a custom event with `_et`.

## Stored lengths

Tested 2026-11-10, read in the BigQuery export on 2026-11-11: one visit sent straight to `/g/collect`, the way a Google tag hit arrives, with a page view and a purchase of two items.

| Sent | Stored |
| --- | --- |
| `ep.*` text of 100, 101 and 300 characters (`č`) | 100, 100, 100 |
| Item `nm` 150, `br` 120, `ca` 150 characters, custom item parameter 150 | 100 each |
| `dl` 499 characters | 499 |
| `dr` 420 characters | 420 |
| `dt` 400 characters | 400 |

So Google keeps the first 100 characters of a longer parameter, counted in characters, not bytes. Vanilla used to drop such a parameter; it now cuts it the same way. `dl`, `dr` and `dt` were kept whole at these lengths; Vanilla still sends at most 1000, 1000 and 300 bytes. Whether standard reports show the same lengths: Not verified.

## Geography and device reach Realtime

Tested, 2026-11-05: events sent to `/mp/collect` of a test property, then read in the GA4 Realtime report.

| Event | Realtime |
| --- | --- |
| `ip_override` 8.8.8.8 | Country: United States |
| `ip_override` a Czech public IPv4 address | Country: Czechia |
| No `ip_override` | Country empty |
| `device.category` `mobile`, `tablet`, `desktop` | Shown correctly |
| City, in all of the above | Empty |

Only country and device category were checked, and only in Realtime. Standard reports and BigQuery: Not verified.

## Older advice

[Google docs](https://developers.google.com/analytics/devguides/collection/protocol/ga4/changelog): `ip_override` and `user_location` were added on 2025-05-14, `device` and `user_agent` on 2025-06-11.

Articles written before those dates, including common guides, say Measurement Protocol cannot carry geography or device data. That was accurate then and is out of date now. Before the change, Google's changelog describes this data only as joined from tagging through `client_id` ([2023-01-23, 2024-09-10](https://developers.google.com/analytics/devguides/collection/protocol/ga4/changelog)), which an untagged property cannot use.

## Browser checks

Single runs on a live website, 2026-11-05. They show what happened in one setup, not a general rule.

| Check | Result | Method |
| --- | --- | --- |
| Safari 26.6.2 on macOS, server-set `vanilla_session`, tracker subdomain on a different IPv4 /16 than the website | Stored expiry 7.0 days, the server requested 400 | Tested: real Safari profile, expiry read from `Cookies.binarycookies` |
| Same Safari visit, `_ga` set by the regular Google tag through GTM, no server container | Stored expiry 400 days, against WebKit's [published 7-day cap](https://webkit.org/blog/8613/intelligent-tracking-prevention-2-1/) for cookies set with `document.cookie`. Only the stored expiry was read; whether the cookie survives past 7 days was not checked | Tested: same file, one measurement. The cause is Not verified |
| uBlock Origin Lite with default lists, Chromium | GTM was neutralised and `_ga` was not created. `s.js` loaded, `/e` returned 204 and `vanilla_session` was set | Tested: one run, consent accepted. Other blockers, stricter lists and other browsers are Not verified |
| Filter lists, 2026-11-10: EasyList, EasyPrivacy, uBlock filters, privacy, badware, quick-fixes and unbreak, AdGuard Base, Tracking Protection and URL Tracking, Fanboy Annoyance, Peter Lowe; DNS lists OISD big, HaGeZi Pro and Pro++, Steven Black unified, AdGuard DNS | No list matched the tracker host, `s.js`, `/e`, `/d`, `/p` or `/health`, for either live install. The Google tag and `/g/collect` were matched by EasyPrivacy, uBlock privacy, AdGuard Tracking Protection and Peter Lowe, and `www.google-analytics.com` by every DNS list except OISD big | Tested: `adblock` (adblock-rust) engine with the lists downloaded that day, no browser. Brave and Ghostery heuristics, Safari Advanced Tracking Protection and user rules: Not verified |
| Brave 1.x (Chromium 157), fresh profile, Shields Standard and then Aggressive, filter lists downloaded, 2026-11-10 | In both modes `s.js` and `/e` passed and `vanilla_session` was set and sent back. The Google tag sent nothing and no `_ga` was set. Brave removed `gclid` from the address and kept `utm_*` | Tested: one run each, Playwright with the installed Brave. The browser must not identify as `HeadlessChrome`, which the tracker filters as a bot |
| Ghostery 10.6.11 (Chrome Web Store build), Chromium, default settings after onboarding, 2026-11-10 | Its Never-Consent feature refused the banner by itself (`cc_cookie` with `necessary` only): the tracker sent the refusal and the limited ping, no event. With consent stored beforehand, `s.js` and `/e` passed and `vanilla_session` was set; `gtm.js` was replaced (307) and nothing reached Google. `gclid` stayed in the address | Tested: one run each |
| Tracker server unreachable, 2026-11-10: the tracker host resolved to an address that never answers, Chromium on macOS, live website | With `<script defer>`: `DOMContentLoaded` and the cookie banner after 75 s. With `async`: banner after 0.35 s, as with a working server. Connection refused or HTTP 502: no delay with either | Tested: one run each, `--host-resolver-rules`; the demo shop, which inserts the script from JavaScript, was not delayed. `tests/e2e/consent.spec.ts` checks the `async` tag |

## /g/collect

Every event now uses `/g/collect`. The following captures explain the common fields; MP observations are historical.

**What MP alone gave.** Tested, 2026-11-06: GA4 Data API over everything sent to the test property through MP on 2026-11-05, including sessions with `campaign_details` and UTM values.

| Report | Result |
| --- | --- |
| Session source / medium | `(not set)` in 70 of 70 sessions |
| Session campaign | `(not set)` in 70 of 70 sessions |
| Default channel group | `Unassigned` |
| New users | 0 |
| Sessions, device, country, pages | Worked |

**What the Google tag sends.** Tested, 2026-11-06: `gtag.js` in Chromium, default consent set, hits captured and blocked so that nothing reached Google.

| Consent | `gcs` | `gcd` | `npa` | Cookies |
| --- | --- | --- | --- | --- |
| All granted | `G111` | `13t3t3t2t5l1` | `0` | `_ga` and `_ga_*` |
| Analytics only | `G101` | `13p3t3p2p5l1` | `1` | `_ga` and `_ga_*` |
| All denied | `G100` | `13p3p3p2p5l1` | `1` | None |

In all of them: one POST with an empty body, `en=page_view`, `_ss=1`, `_fv=1`, and the full URL in `dl`, including `gclid`. Denied hits use a new `cid`. After a later grant the tag sent no second `page_view`. `dma` and `dma_cps` are left out here, because `dma` depends on the visitor's region. Vanilla sends the consent state it knows at that moment, always with `t` and `p`.

**What this project sends.** `v tid _p gcs gcd npa cid sid sct seg _s en dl dr dt ul sr _uip _et _ss _fv _nsi`, as a POST with an empty body and the visitor's `User-Agent`. `_et` carries validated engagement time on any event. `sct` is the visitor's session count, kept in the signed cookie, and `_nsi` marks the first hit of a session. The Google tag sent `_nsi` with a first visit only, not with a later session of the same visitor (captured 2026-11-14, [Session length](#session-length)). The denied ping leaves out `_uip`. The fields come from the hits above.

**What came back.** Tested, 2026-11-06: 7 hits built by `buildCollectUrl` and sent to `/g/collect` of the test property, then read in Realtime through the GA4 Data API.

| Sent | Realtime |
| --- | --- |
| 6 hits with analytics granted, `_ss=1`, `_fv=1` | 6 `page_view`, 6 `session_start`, 6 `first_visit` |
| `_uip` 8.8.8.8, 4 hits | Country: United States |
| `_uip` 1.1.1.1, 2 hits | Country: India. So the country comes from `_uip`, not from the sending machine |
| 1 denied hit with `gcs=G100` | Not shown |

`/g/collect` answered 204 to all of them, which proves delivery only.

**What the standard reports showed.** Tested, 2026-11-06, GA4 Data API, about seven hours after the hits, so the day may still be incomplete: 11 sessions so far, against 0 usable sources in the 70 sessions sent through MP alone.

| Sent | Standard report |
| --- | --- |
| UTM in `dl` | Session source / medium `vctest / browser`, campaign filled |
| `utm_medium=cpc` | `vctest / cpc`, channel `Paid Other` |
| `dr` from another site | `example.org / referral`, channel `Referral` |
| No `dr`, no UTM | `(direct) / (none)`, channel `Direct` |
| `dr` from Google with an invented `gclid`, no Ads link | `google / organic`, channel `Organic Search`. An invented click ID says nothing about real ad attribution |
| `_fv=1` | New users 10 of 10 users |
| `gcs=G100` ping | Not shown |

## Pending

**Not verified yet.** These need time in standard reports, not a validator.

- A real Google Ads click: whether the session shows `google / cpc` and the campaign, and whether a conversion is credited through the link between GA4 and Ads.
- Whether a denied ping appears in any report, or feeds modeling.
- Whether [known bot exclusion](https://support.google.com/analytics/answer/9888366) applies to Measurement Protocol events. The page does not mention them.

## All-collect comparison

Tested 2026-11-08: manual live GA4 Data API comparison by campaign for hits sent November 7–8. The all-collect script used fixed `_p` per page, rising `_s`, `seg` and `_et`.

| Transport | Session and source results |
| --- | --- |
| Every event through collect | 100% of tested hits in the correct attributed session; purchases 4/4 |
| Collect opener plus MP | MP hits kept their source in 0 of 8 to 8 of 8 per test group, depending on timing; attributed purchases 2/4, `generate_lead` 0/4 |
| Mixed production tracker | First page and later pages could form two sessions |

A collect purchase used `en=purchase`, `cu=CZK`, `epn.value`, `ep.transaction_id`, and `pr1=idVT1~nmVanilla test~pr1990~qt1`. The comparison motivates removing MP entirely. Raw experiment artifacts are not stored in this repository; these are recorded manual observations. Real Ads imports remain unverified.

## Standard reports versus BigQuery

Tested 2026-11-08 to 2026-11-10: the production tracker in headless Chromium and WebKit, groups of 4 to 14 test visitors, some of them at the same time from one address. The same hits were read in the GA4 Data API (standard reports) and in the daily BigQuery export of the same property.

| Group | Standard reports, hits after the landing page | BigQuery export, hits with consent |
| --- | --- | --- |
| 14 at once, 2026-11-08 | 13 of 26 kept the session source; the rest showed `(not set)` | 97 hits (139 with limited pings), 14 visitors, 14 sessions, campaign on every hit |
| 14 at once, then 4 and 5, 2026-11-09 morning | `(not set)` in 7 of 23 visits | 141 hits (171 with limited pings), 23 visitors, 23 sessions, campaign on every hit |
| Mobile, back button, WebKit, 5 at once | No `(not set)` | 80 hits, 11 visitors, 11 sessions, campaign on every hit |
| 12 at once and 4 one by one, twice | `(not set)` in 1 of 32 visits | 202 hits (271 with limited pings), 32 visitors, 32 sessions, campaign on every hit |
| 16 per run, up to 12 at once, three times (Chromium, Firefox, right after a restart), 2026-11-10 | `(not set)` in 5 of 48 visits | 303 hits (363 with limited pings), 48 visitors, 48 sessions, campaign on every hit |

In BigQuery every hit sent with consent carried the visitor's `user_pseudo_id` and `ga_session_id`, and `session_traffic_source_last_click` named the test campaign, including all 47 purchases and 36 `generate_lead` events. Limited pings are stored without a visitor ID and are counted apart. Landing hits kept their source in both. In the standard reports the affected later hits appeared as a separate user without `first_visit`.

Engaged sessions: in the demo shop on 2026-11-08 both properties counted 12 engaged sessions of 12, all in visits of several pages. The single-page thresholds were not tested on their own.

So in our data the hits leave this server with the right identity and session, and the `(not set)` appears only in the standard reports: the export of the same hits was complete, and the regular GTM property showed the same effect in the same visits (below). Neither concurrency nor time since a server restart explained it. How Google produces it internally: Not verified.

The Google tag shows the same. On 2026-11-10 the demo shop ran GTM and Vanilla in the same visits, 24 at once, three times: the GTM property put later hits under `(not set)` in each run (16 events in one of them), including a purchase. After `sct` and `_nsi` were added, Vanilla had none in those demo runs, but on the main site 2 of 16 and 3 of 16 visits still lost the source, so the two fields align the hit with the Google tag without removing the effect. Its effect on conversions imported into Google Ads was not tested.

The demo shop's BigQuery export for 2026-11-10, read on 2026-11-11, settles it, with two exceptions. In every demo run that day, in both properties, each visitor had one session (two in the return test) and every hit with consent named the test campaign, including the runs where the standard reports showed `(not set)`. The exceptions: the GTM property lost the campaign of one whole visit (6 hits), and Vanilla created 5 extra visitors from exit `page_engagement` hits that arrived without a cookie, each a session without a page view. Since 2026-11-11 such a hit is dropped. In the run of 14 at once, Vanilla had all 6 purchases with the campaign and GTM had all 6 too, although the reports put 2 and 1 of them under `(not set)`, in different visits. Hits without a client ID are the limited pings.

Missing events in that export come from the tracker's own per-address rate limit, not from GA4. With 28 test visitors at once from one address, Vanilla lost the ends of the funnels after 429 responses and retries: 0 of 12 purchases and 2 of 12 `add_payment_info` arrived, while GTM, which does not pass through that limit, had 12 of 12. An earlier run of the same size lost 2 `add_to_cart`, 3 `begin_checkout` and a few page views and engagement events, but all 12 purchases arrived. At 14 at once Vanilla had the same ecommerce events per visit as the unloaded run; only one `page_engagement` differed. Those runs used 300 requests a minute and 30 simultaneous deliveries per address; since 2026-11-12 the limit is 1,200 and 100, with 300 simultaneous deliveries in total.

## History changes

Captured 2026-11-10: `gtag.js` in Chromium with enhanced measurement and its page changes on, each change on a freshly loaded page, hits answered locally.

| Change | Google tag | Vanilla |
| --- | --- | --- |
| `replaceState` removes a query parameter | 1 more `page_view` | Same |
| `replaceState` or `pushState` to another path or query | 1 more `page_view` | Same |
| Only the fragment (`#…`): link, `location.hash`, back | None | Same since 2026-11-10; before, 1 more `page_view` |
| `replaceState` to the same URL | None | Same |

A site whose Google tag has page changes turned off, like the demo shop's GTM setup, counts fewer page views there than Vanilla.

## Session length

Captured 2026-11-14: `gtag.js` (a copy downloaded that day with a placeholder Measurement ID, default settings) in headless Chromium 156, every hit answered locally, nothing sent to Google. Before the page load the `_ga` and `_ga_<ID>` cookies were set by hand. A first visit showed their format: `_ga=GA1.1.<random>.<first seconds>` and `_ga_<ID>=GS2.1.s<session start>$o<session count>$g<engaged, 0 or 1>$t<last hit>$j…$l0$h0`, times in Unix seconds.

| Session cookie before the page load | `page_view` sent | Session |
| --- | --- | --- |
| None | `sid` = now, `sct=1`, `_ss=1`, `_nsi=1`, `_fv=1`, `seg=0` | First visit |
| Started 2 h ago, last hit 1 min ago | `sid` = start, `sct=3`, no `_ss`, `_nsi` or `_fv`, `seg=1` | Same session |
| Started 25 h ago, last hit 1 min ago | The same: `sid` unchanged, `sct=3`, no `_ss` | Same session |
| Started 49 h ago, last hit 1 min ago | The same | Same session |
| Started 2 h ago, last hit 31 min ago | `sid` = now, `sct=4`, `_ss=1`, no `_nsi` or `_fv`, `seg=0` | New session |

So the Google tag sets no maximum length: only 30 minutes without a hit end a session. The 24 hours often quoted is a Measurement Protocol rule (an MP event with a session ID has to arrive within 24 hours of the session start) and does not apply to collect hits. Whether GA4 splits such a long session in its reports: Not verified.

`_nsi` came with the first visit only, not with the new session after 31 minutes, in this one capture. Vanilla sends `_nsi` at every session start; whether the difference changes anything in reports: Not verified.

The session timeout is a property setting (`session_duration` in the script, 30 minutes by default). Vanilla always uses 30 minutes.

## Engaged sessions

Same setup, captured 2026-11-14: one page loaded without cookies, events sent with `gtag("event", …)` after visible waits, then the exit (`visibilitychange` to hidden and `pagehide`, dispatched on the open page so the capture sees the last hit). Values per hit, `_et` in milliseconds. In every run the page view opened the session with `_ss=1` and `seg=0`.

| Run | Hits after the page view |
| --- | --- |
| Three custom events 6 s apart | `test_a` `_et=6079` `seg=0`; `test_b` `_et=6002` `seg=1`; `test_c` `_et=6004` `seg=1`; exit `user_engagement` `_et=1002` `seg=1` |
| `generate_lead`, then `purchase` 6 s later | `generate_lead` `_et=6081` `seg=0`; `purchase` `_et=6002` `seg=1`; exit `seg=1` |
| `generate_lead` and `purchase` after 1 s each | `_et=1059` `seg=0`; `_et=1004` `seg=0`; exit `_et=1002` `seg=0` |
| One wait of 12 s | `test_a` `_et=12077` `seg=1`; exit `seg=1` |
| 6 s visible, 10 s hidden, 6 s visible | `test_a` `_et=12077` `seg=1`; hidden time does not count |
| Consent `default` denied, granted after 8 s, an event 3 s later | The denied ping opened the session. After the grant `user_engagement` `_et=8069` `seg=0`, then `test_a` `_et=3004` `seg=1` |
| 6 s on page 1, exit, page 2 of the same session | Page 1 exit `_et=6064` `seg=0`, cookie `$g0`. Page 2 `page_view` `seg=1` without `_ss`, `test_a` `seg=1`, cookie `$g1` |
| 12 s on page 1, then page 2 | Page 1 `test_a` `seg=1`, cookie `$g1`. Page 2 `page_view` and `test_b` (`_et=2004`) `seg=1` |
| Cookie of a running session with `$g0`, page load | `page_view` `seg=1`, `test_a` (`_et=2005`) `seg=1`, cookie afterwards `$g1` |

The rule, as captured:

- The hit that opens a session has `seg=0`.
- After it, the session is engaged by a page view, or once the engagement time of its hits adds up to more than 10 seconds, time before consent included. Event names do not matter: `generate_lead` and `purchase` alone left `seg=0`. Key events are a property setting the tag cannot see; whether GA4 counts such a session as engaged in its reports: Not verified.
- Once engaged, every later hit of the session has `seg=1`. The state is kept in the cookie (`$g1`) and a new session resets it.

The script adds the time up per page load, but a later page load starts with a page view, which engages the session anyway, so a sum over the session gives the same flags. In the same copy of the script the threshold is `session_engaged_time`, 10,000 ms by default, compared with "greater than"; like the session timeout it is a property setting. These two details come from reading the script, not from a capture.

Vanilla in the same runs, 2026-11-14: the tracker and collector built from this repository in Chromium, Google replaced by a local stub.

| Run | Before the change | After |
| --- | --- | --- |
| Three `view_item` 6 s apart, then the exit | `seg` 0, 0, 0, exit 0 | 0, 1, 1, exit 1, as the Google tag |
| `generate_lead` after 1 s, then the exit | 0, exit 0 | The same, as the Google tag |
| 6 s on page 1, exit, page 2 with `view_item` after 3 s | Page 2 `page_view` 1, then `view_item` 0 and exit 0 | Page 2 all 1, as the Google tag |

The tag numbers requests, not events, in `_s`: two events sent in one request carried the same `_s`. Vanilla sends one request per event, so its count per event is the same thing.

## Collect wire format

Reviewed 2026-11-08 against primary public implementations:

- David Vallejo / Analytics Debugger [ga4mp schema](https://github.com/analytics-debugger/ga4mp/blob/main/src/modules/ga4Schema.js) maps currency to `cu`, page ID to `_p`, hit count to `_s`, and item fields to `id nm pr qt br ca c2 c3 c4 c5 va ln li lp af cp ds lo` (also promotion and creative fields).
- Its [serializer](https://github.com/analytics-debugger/ga4mp/blob/main/src/ga4mp.js) uses `ep.*` for text, `epn.*` for numbers, `pr1` onwards for items, and `~` between item fields. Custom item pairs use `k0`/`v0` through `k9`/`v9`, then letters `A` onwards.
- Cloudflare's [GA4 request builder](https://github.com/managed-components/google-analytics-4/blob/main/src/requestBuilder.ts) independently builds collect ecommerce URLs with `cu`, `ep`/`epn`, and numbered products. `value`, `tax` and `shipping` sent as numeric text go out as `epn.*`, because GA4 sums only numbers; other numeric text stays `ep.*`. Booleans serialize as text.

Vanilla encodes the whole query with URLSearchParams. Within item values, a literal `~` is doubled to `~~`, the same escape the Google tag uses (captured 2026-11-09: `item_brand: "a~~b"` went out as `bra~~~~b`), so it cannot introduce another field. An earlier `%7E` escape showed up literally in GA4 item reports. Unicode otherwise round-trips unchanged.

Small hits from the Google tag are a POST with an empty body. Captured 2026-11-10 (`gtag.js` in Chromium, hits answered locally): a purchase stayed in the URL up to about 1850 bytes (10 items) and moved to the body from about 2080 bytes (12 items). Then the URL keeps the shared fields (`v tid _p gcs gcd npa cid sid sct seg _s dl dt ul sr cu` and session flags) and a one-line body carries `en`, `ep.*`, `epn.*`, `pr1`…`prN` and `_et`. 200 items made a 23 KiB body in one request.

Google accepts at most 16,384 bytes of body; the URL does not count. Measured 2026-11-10 with a placeholder Measurement ID: a body of 16,384 bytes gave 204, 16,385 bytes 413, also with a 1,900-byte URL. The Google tag sent live to a test property: 80 and 120 items (9.3 and 14.0 KiB) 204, 160 and 200 items (18.7 and 23.5 KiB) 413, so the purchase was lost. Vanilla splits the same way above 2000 URL bytes. Above 16 KiB it leaves out the last items until the body fits and logs how many, so the purchase, its value and transaction ID still arrive. It does not split a purchase into several hits. No collect backdating or `timestamp_micros` is used.
