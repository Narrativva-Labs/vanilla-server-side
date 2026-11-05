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
- The consent logic is one pure function with a table of rules; behavior is unchanged.
- `npm run test:e2e` runs the consent flow in Chromium and WebKit, also in CI.

No release is tagged yet. Install and update follow the default branch.
