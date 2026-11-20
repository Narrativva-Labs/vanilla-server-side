# Changelog

## Unreleased

- Vendor Visitor Verdict server 0.2.1: reject Google customer cloud DNS, scope purpose to verified rules and record registry evidence.
- Assert the actual 16 KiB posted body limit, preserved purchase value/currency and exact retained item prefix; cover the refresh warning host cap.

- Optional agent verification labels and cache health, including agent_purpose.
- Optional Visitor Verdict browser class/phase on events and pings.
- Reserve agent_verification, agent_operator, agent_purpose and agent_claim; client values never pass through.

## 0.1.0 - 2026-11-17

First release. Tested on the demo shop, the author's website and two small live sites with real visitors; what is verified and what is not is in [docs/verification.md](docs/verification.md).

- The install test runs on x86 and ARM.

### 2026-11-15

- Send cookieless pings for every allowed event, sharing transient page identity and rising hit order, with visitor IP and ordinary sanitized ecommerce parameters. Never include cookies, click IDs or `user_data`; never retry; exclude `page_engagement`.
- Treat readable undecided banners as denied for pings only. Remove the fixed ping delay; honor a Google default's bounded `wait_for_update` when no banner is readable.
- Preserve later full delivery of undecided events after a grant and drop the queue after refusal. Document intentional BigQuery duplication, privacy disclosure and `DENIED_PINGS=off`.
- Denied pings checked against a capture of the Google tag's denied sequence and in BigQuery: stored without a visitor ID, with the visitor's country.

### Before 2026-11-15

- Initial self-hosted tracker and collector.
- A `gtag("event", …)` command with `send_to` is skipped: it is addressed to one destination, such as Google Ads or Merchant Center plugins, and would double page views and items.
- Consent-gated tracking, ecommerce events and parallel GA4 property support.
- Ubuntu/Debian installer, Caddy TLS proxy, Docker Compose deployment and guarded updater.
- Optional `GA4_REGION=eu` for Google's EU collection endpoint.
- Server-side filter for obvious bots by User-Agent, counted in `/health` as `botsFiltered`.
- `npm run verify:mp` checks real payloads against Google's validation server.
- `npm run demo` runs the tracker and collector locally against a stub.
- `page_location`, `page_referrer` and `page_title` are trimmed to the 256 UTF-8 bytes measured on the validator, instead of 100 characters.
- An empty referrer stays empty instead of becoming `/`.
- The console warning about unresolved consent stays silent while a supported banner waits for the visitor.
- A decided banner beats Google defaults, and a later change in the banner beats an older Google update.
- URLs set by the site are cleaned in the browser.
- `update.sh` works when root owns .env and explains a checkout that is not on a branch.
- `npm run verify:mp` follows `GA4_REGION`.
- The cookieless mode is removed: see [One mode, with a cookie](docs/decisions.md#one-mode-with-a-cookie). Its setting in .env is ignored, so an install that used it now waits for consent, and it needs `COOKIE_SECRET` and a tracker inside `COOKIE_DOMAIN`.
- Text parameters and item fields over 100 characters are cut to 100, as Google stores them, instead of being left out.
- A purchase over Google's 16 KiB hit limit (about 130 items) leaves out the last items instead of being lost; Google refuses such a hit from the Google tag too.
- The script tag uses `async` instead of `defer`, so a tracker server that is down never holds the page or its cookie banner.
- Caddy compresses responses, so `s.js` goes out at about 6 KB instead of 16 KB.
- `LOG_EVENTS=on` writes one line per event: name, answer and outcome, nothing about the visitor.
- The consent logic is one pure function with a table of rules; behavior is unchanged.
- One `/g/collect` hit now opens each session, which gives GA4 session source, New users and `session_start`. Measurement Protocol carries everything else. `campaign_details` is gone, because no report used it.
- `gclid`, `gbraid` and `wbraid` reach Google in that hit when `ad_storage` and `ad_user_data` are granted, so conversions can be imported into Google Ads through GA4.
- A withdrawal is no longer rate limited, and it stops a request that is waiting for session opening.
- Engagement time survives a `/g/collect` hit.
- The rate limit is 1,200 requests a minute and 100 simultaneous deliveries per IP, 300 in total, instead of 300, 30 and 100: 28 visitors at once behind one address lost purchases to 429.
- A page restored from the back/forward cache sends a page view.
- A SPA page reports the previous page as referrer and closes its engagement time first. Android tablets count as tablets.
- A withdrawal is stored even when it overtakes the visitor's first event.
- `tests/fuzz.test.ts` checks rules over random sequences, with a failing Google.
- The maps of visitor state have a fixed size, and the tracker sends no `Referer` with its requests.
- A page that stays denied sends one limited ping, as in Advanced Consent Mode. Update your privacy text before you upgrade.
- `npm run test:e2e` runs the consent flow in Chromium and WebKit, also in CI.
- An exit `page_engagement` that arrives without a cookie is dropped instead of creating a visitor with a session and no page view.
- A session no longer ends after 24 hours of steady activity, only after 30 idle minutes, as the Google tag does (captured 2026-11-14). The 24 hours came from a Measurement Protocol rule.
- `seg` follows the session like the Google tag's (captured 2026-11-14): the signed cookie sums engagement time, more than 10 seconds or a later page view engages the session, and it stays engaged until it ends. Before, three hits 6 s apart on one page sent `seg=0` every time.

No release is tagged yet. Install and update follow the default branch.
