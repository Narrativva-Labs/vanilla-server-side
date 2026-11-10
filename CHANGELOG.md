# Changelog

## 0.1.0 - unreleased

- Initial self-hosted tracker and collector.
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
- A purchase over Google's 16 KiB hit limit (about 130 items) leaves out the last items instead of being lost; Google refuses such a hit from the Google tag too.
- The script tag uses `async` instead of `defer`, so a tracker server that is down never holds the page or its cookie banner.
- `LOG_EVENTS=on` writes one line per event: name, answer and outcome, nothing about the visitor.
- The consent logic is one pure function with a table of rules; behavior is unchanged.
- One `/g/collect` hit now opens each session, which gives GA4 session source, New users and `session_start`. Measurement Protocol carries everything else. `campaign_details` is gone, because no report used it.
- `gclid`, `gbraid` and `wbraid` reach Google in that hit when `ad_storage` and `ad_user_data` are granted, so conversions can be imported into Google Ads through GA4.
- A withdrawal is no longer rate limited, and it stops a request that is waiting for session opening.
- A session also ends after 24 hours on the server, and engagement time survives a `/g/collect` hit.
- A page restored from the back/forward cache sends a page view.
- A SPA page reports the previous page as referrer and closes its engagement time first. Android tablets count as tablets.
- A withdrawal is stored even when it overtakes the visitor's first event.
- `tests/fuzz.test.ts` checks rules over random sequences, with a failing Google.
- The maps of visitor state have a fixed size, and the tracker sends no `Referer` with its requests.
- A page that stays denied sends one limited ping, as in Advanced Consent Mode. Update your privacy text before you upgrade.
- `npm run test:e2e` runs the consent flow in Chromium and WebKit, also in CI.

No release is tagged yet. Install and update follow the default branch.
