# Measurement Protocol notes

Where the documentation, the validation server and the reports disagree, and what this project does about it.

Every row has a source:

- **Tested**: run by this project, with date and method. `npm run verify:mp` reruns all validator rows. It needs `GA4_MEASUREMENT_ID` and `GA4_API_SECRET` and calls `https://www.google-analytics.com/debug/mp/collect` only, or the same path on `region1.google-analytics.com` with `GA4_REGION=eu`. The results below come from the default endpoint.
- **Google docs**: the linked page, read on 2026-11-05.
- **Not verified**: not confirmed by this project.

The validator was run against a web data stream. It checks structure, and [Google says](https://developers.google.com/analytics/devguides/collection/protocol/ga4/validating-events) events sent to it do not appear in reports. A validator result is not proof of what the live endpoint does.

## Validation modes matter

[Google docs](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference): `RELAXED` is the default and "only rejects requests that are malformed"; it "ignores parameters that exceed limits". `ENFORCE_RECOMMENDATIONS` rejects them. Google recommends the strict mode while validating and leaving the field out in production.

This project sends production requests without `validation_behavior`, and `verify:mp` validates with `ENFORCE_RECOMMENDATIONS` unless a row says otherwise.

## Validator results

All rows: Tested, 2026-11-05, `npm run verify:mp`.

| Claim checked | Documentation | Result |
| --- | --- | --- |
| Payloads built by this repository | | All accepted: `page_view` with `campaign_details`, device and `ip_override`; `purchase`; `page_engagement`; 5000-character URL, referrer and title after trimming |
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

## What the repository does with this

| Finding | Behavior |
| --- | --- |
| `device.model` and `device.browser` required in strict mode | Both are always present when `device` is sent, with generic fallbacks. A blank model falls back to the category |
| Page text limit | `page_location`, `page_referrer` and `page_title` are cut to 256 UTF-8 bytes on whole characters, without a dangling `%` escape. The campaign is read in the browser before this, so a cut URL does not lose UTM values |
| Reserved names | All 34 stay blocked. The accepted 14 are still documented as reserved, and an undocumented acceptance is not a contract |
| `user_engagement` | Final visible time goes out as the custom event `page_engagement` |
| Other text limits | Unchanged: values over 100 characters are dropped with a diagnostic. A value of 51 to 100 multi-byte characters passes here and would fail strict validation. Live effect: Not verified |
| Item parameters | Unchanged: documented fields plus 27 custom. An item with more than 27 fields in total can fail strict validation. Live effect: Not verified |

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

## Pending

**Not verified yet.** These need time in standard reports, not a validator.

- `campaign_details` and session source: does Session source / medium show the sent values in standard reports? The field is [documented](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference/events#campaign_details), it passes the validator and Google says it is not visible in DebugView. A [2026 third-party test](https://www.markus-baersch.de/blog/data-manager-api-echter-ersatz-fuer-das-measurement-protocol/) of standalone server events reports `(not set)` session source. This project has not confirmed or refuted that.
- New users: probably 0, because `first_visit` is reserved. A [2022 third-party test](https://www.markus-baersch.de/blog/google-analytics-4-measurement-protocol-fuer-websites-experiment/) reported 0. Not confirmed by this project.
- Engaged sessions without `user_engagement`, with engagement time carried by `engagement_time_msec` and `page_engagement`.
- What the live endpoint does with over-limit text and over-limit item parameters.
- Whether [known bot exclusion](https://support.google.com/analytics/answer/9888366) applies to Measurement Protocol events. The page does not mention them.
