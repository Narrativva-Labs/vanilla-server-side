# Changelog

## Unreleased

- Use event-scoped vv_type/vv_detail from Visitor Verdict server 0.3.x (bundled 0.3.4); reserve old and new client label names and retain automatic/ecommerce fields within the 16 KiB limit.
- Retain bounded session/page evidence with proof-capped expiry, monotonic renewal for the same type/operator, latest equal-rank attribution and separate admission budgets; reclaim expiry via a bounded heap before LRU eviction.
- Join parallel first hits before the server cookie exists only by browser client ID plus a random in-memory bootstrap token created after consent; a known client ID alone no longer attaches to another visitor's first visit. Deploy the server before the tracker cache (300 s) refreshes.
- Add opt-in `data-vv-wait-ms` (0–1000, default 0): the first hits of a page wait for the Visitor Verdict initial class or the deadline, whichever comes first; leaving the page releases them at once.
- Add DENIED_PING_IP (full/truncated/off) and DENIED_PING_USER_AGENT (on/off) for `/d`, retaining full IP and browser UA by default; UA off sends the fixed neutral value `unknown`.
- Clarify default cookieless delivery while denied or a supported banner is undecided, transmitted fields, page-local IDs, first-ping session time, labels and ping text limits.
- Add optional HEALTH_TOKEN protection for detailed health status, validate TRUST_PROXY for environment and programmatic configuration, and document proxy deployment.
- Expose aggregate verification counters and bounded per-operator replay budgets/status; preserve typed replay exhaustion across package copies.
- Verified operators with unknown purpose map to agent_verified with unknown retained in vv_detail; neither a crawler nor user-directed role is inferred.
- Cover posted body limits, purchase fields and item prefixes, refresh hostname caps and collector delivery boundaries.
- The tracker no longer forwards GTM's own `gtm.*` keys (such as `gtm.uniqueEventId`) as event parameters. They appeared when the tracker loaded after GTM and replayed objects GTM had already processed; the collector dropped them, so GA4 data was not affected.

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
- All events use `/g/collect`; Measurement Protocol and `GA4_API_SECRET` are no longer used (the secret is ignored with a startup warning).
- One `/g/collect` hit now opens each session, which gives GA4 session source, New users and `session_start`. `campaign_details` is gone, because no report used it.
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

Install and update follow the default branch; releases are tagged (latest v0.1.0).
