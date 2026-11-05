# Changelog

## 0.1.0 - unreleased

- Initial self-hosted tracker and collector.
- Cookie and cookieless consent modes, ecommerce events and parallel GA4 property support.
- Ubuntu/Debian installer, Caddy TLS proxy, Docker Compose deployment and guarded updater.
- Optional `GA4_REGION=eu` for Google's EU collection endpoint.
- Server-side filter for obvious bots by User-Agent, counted in `/health` as `botsFiltered`.
- `npm run verify:mp` checks real payloads against Google's validation server.
- `npm run demo` runs the tracker and collector locally against a stub.
- `page_location`, `page_referrer` and `page_title` are trimmed to the 256 UTF-8 bytes measured on the validator, instead of 100 characters.
- An empty referrer stays empty instead of becoming `/`.
- The console warning about unresolved consent stays silent while a supported banner waits for the visitor.

Release tags are the source of versioned deployments. Changes on the default branch are unreleased until a tag and release notes exist.
