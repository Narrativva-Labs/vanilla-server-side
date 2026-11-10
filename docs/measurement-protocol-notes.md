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
| Over-limit text in `RELAXED` | Reference: "ignores parameters that exceed limits" | 2000 characters returned no message. Whether the live endpoint drops the parameter, cuts it or keeps it: Not verified |
| `ip_override` format | Reference: IP address | `192.0.2.1`, `2001:db8::1` and `not-an-ip` all accepted, so the validator does not check it |

Reserved names, as answered by the validator:

- Rejected: `ad_activeview ad_click ad_exposure ad_query adunit_exposure app_clear_data app_install app_remove app_update error first_open first_visit notification_dismiss notification_foreground notification_open notification_receive os_update session_start user_engagement in_app_purchase`
- Accepted: `ad_reward app_exception app_store_refund app_upgrade dynamic_link_app_open dynamic_link_app_update dynamic_link_first_open firebase_campaign firebase_in_app_message_action firebase_in_app_message_dismiss firebase_in_app_message_impression notification_send ad_impression screen_view`

## Current parameter limits

The collect serializer retains the previous validator limits: 25 parameters including automatic fields, 200 items, standard item fields plus 27 custom fields, other strings up to 100 characters, and page text trimmed to 256 UTF-8 bytes inside event parameters. `dl` and `dr` keep 1000 bytes and `dt` 300 on every hit, so long campaign values survive. Names and engagement values are checked before serialization. These are conservative local limits, not a new measurement of collect's acceptance. Browser/model fields belonged to the retired MP body; collect forwards the browser User-Agent instead. `page_engagement` remains a custom event with `_et`.

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
| Same Safari visit, `_ga` set by the regular Google tag through GTM, no server container | Stored expiry 400 days. This contradicts WebKit's [published 7-day cap](https://webkit.org/blog/8613/intelligent-tracking-prevention-2-1/) for cookies set with `document.cookie` | Tested: same file, one measurement. The cause is Not verified |
| uBlock Origin Lite with default lists, Chromium | GTM was neutralised and `_ga` was not created. `s.js` loaded, `/e` returned 204 and `vanilla_session` was set | Tested: one run, consent accepted. Other blockers, stricter lists and other browsers are Not verified |

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

**What this project sends.** `v tid _p gcs gcd npa cid sid sct seg _s en dl dr dt ul sr _uip _et _ss _fv _nsi`, as a POST with an empty body and the visitor's `User-Agent`. `_et` carries validated engagement time on any event. `sct` is the visitor's session count, kept in the signed cookie, and `_nsi` marks the first hit of a session, as the Google tag does. The denied ping leaves out `_uip`. The fields come from the hits above.

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
- Engaged sessions, with engagement time carried by `engagement_time_msec` and `page_engagement`. The first run showed 0.
- What the live endpoint does with over-limit text and over-limit item parameters.
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

| Group | Standard reports, hits after the landing page | BigQuery export |
| --- | --- | --- |
| 14 at once, 2026-11-08 | 13 of 26 kept the session source; the rest showed `(not set)` | 97 hits, 14 visitors, 14 sessions, campaign on every hit |
| 14 at once, then 4 and 5, 2026-11-09 morning | `(not set)` in 7 of 23 visits | 141 hits, 23 visitors, 23 sessions, campaign on every hit |
| Mobile, back button, WebKit, 5 at once | No `(not set)` | 80 hits, 11 visitors, 11 sessions, campaign on every hit |
| 12 at once and 4 one by one, twice | `(not set)` in 1 of 32 visits | 202 hits, 32 visitors, 32 sessions, campaign on every hit |

In BigQuery every hit carried the visitor's `user_pseudo_id` and `ga_session_id`, and `session_traffic_source_last_click` named the test campaign, including all 29 purchases and 21 `generate_lead` events. Landing hits kept their source in both. In the standard reports the affected later hits appeared as a separate user without `first_visit`.

So the hits leave this server with the right identity and session; the `(not set)` comes from how GA4 processes standard reports. Neither concurrency nor time since a server restart explained it. Whether the Google tag shows the same under these conditions was not tested, and neither was its effect on conversions imported into Google Ads.

## Collect wire format

Reviewed 2026-11-08 against primary public implementations:

- David Vallejo / Analytics Debugger [ga4mp schema](https://github.com/analytics-debugger/ga4mp/blob/main/src/modules/ga4Schema.js) maps currency to `cu`, page ID to `_p`, hit count to `_s`, and item fields to `id nm pr qt br ca c2 c3 c4 c5 va ln li lp af cp ds lo` (also promotion and creative fields).
- Its [serializer](https://github.com/analytics-debugger/ga4mp/blob/main/src/ga4mp.js) uses `ep.*` for text, `epn.*` for numbers, `pr1` onwards for items, and `~` between item fields. Custom item pairs use `k0`/`v0` through `k9`/`v9`, then letters `A` onwards.
- Cloudflare's [GA4 request builder](https://github.com/managed-components/google-analytics-4/blob/main/src/requestBuilder.ts) independently builds collect ecommerce URLs with `cu`, `ep`/`epn`, and numbered products. `value`, `tax` and `shipping` sent as numeric text go out as `epn.*`, because GA4 sums only numbers; other numeric text stays `ep.*`. Booleans serialize as text.

Vanilla encodes the whole query with URLSearchParams. Within item values, a literal `~` is doubled to `~~`, the same escape the Google tag uses (captured 2026-11-09: `item_brand: "a~~b"` went out as `bra~~~~b`), so it cannot introduce another field. An earlier `%7E` escape showed up literally in GA4 item reports. Unicode otherwise round-trips unchanged.

The observed Google tag capture above was POST with an empty body. The public [ga4mp transport](https://github.com/analytics-debugger/ga4mp/blob/main/src/modules/request.js) also puts parameters in the URL. The exact common-query/event-body split for large hits has **not been verified**, so Vanilla keeps this form and drops URLs over 8192 encoded bytes with a value-free diagnostic. It does not split a purchase or silently truncate its item list to fit. No collect backdating or `timestamp_micros` is used.
