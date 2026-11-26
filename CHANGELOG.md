# Changelog

## 0.6.0 — 2026-11-26

- Support Visitor Verdict 1.6.0 late human → suspicious escalation once per document, independently of the original final update, across consent waiting and denied ping queues. Consent replays remain deduplicated.
- Retain the escalated browser class on subsequent events, including ecommerce; existing server label retention and B7 verified-agent priority remain unchanged.
- Forward only allowlisted `traffic_replay` values (`consent`, `late`) on dedicated updates, including denied pings; strip the field from ordinary GA4 events.
- Remain compatible with older detectors. No .env changes; update the collector before the browser bundle.

## 0.5.0 — 2026-11-25

- Bundle `visitor-verdict-server` 0.8.0 (see `vendor/README.md` for SHA-512) and synchronize the 998-vector differential corpus and `CONTRACT.md`.
- Adopt the 10-value `vv_type` taxonomy:
  - `pending` → `unclassified` (session rank 0, never stored in session memory).
  - IP-verified user-directed fetchers (`ChatGPT-User`, `Claude-User`, `Perplexity-User`, `MistralAI-User`, `Kimi-User`, Google user-triggered fetchers) → `crawler_verified` while retaining `purpose = user_directed` in `vv_detail`. Verified Web Bot Auth browser agents and IP-verified agent tokens (`Claude-Agent`, `Google-Agent`) stay `agent_verified`.
  - Unverified crawler and fetcher UA claims (including `meta-externalagent` and uncertain `ip_mismatch` on crawler/fetcher tokens) → `crawler_unverified` (session rank 3). Unverified agent tokens, unmapped tokens (`Blueno`), unverified WBA signatures, and browser `declared_agent` markers stay `agent_unverified` (rank 3).
- Keep B7 Verdict Echo wire schema v1 backward compatible with cached 0.2.0 clients: IP-verified fetchers emit `type: "crawler_verified", purpose: "crawler"` on the wire (while GA4 `vv_detail` keeps `user_directed`) and are never pushed to `dataLayer`; current `serverVerdict()` also tolerates `crawler_verified` with `purpose: "user_directed"`. Unverified types never emit an echo.
- Expose all 10 `vv_type` buckets in `/health` `agentVerification.counters.{events,pings}.byType` (`unclassified` and `crawler_unverified` replace `pending`).
- Document the new value dictionary and a historical BigQuery migration `CASE` for pre-0.5.0 data in `README.md` and `INSTALL.md`.

### Label migration (0.4.x → 0.5.0)

| Situation | 0.4.x `vv_type` | 0.5.0 `vv_type` |
|---|---|---|
| No browser signal and no qualifying server claim | `pending` | `unclassified` |
| IP-verified user-directed fetcher (`ChatGPT-User`, `Claude-User`, `Perplexity-User`, `MistralAI-User`, `Kimi-User`, Google user-triggered fetchers) | `agent_verified` | `crawler_verified` (`purpose=user_directed` kept in `vv_detail`) |
| Unverified crawler or fetcher UA claim (incl. `meta-externalagent`, uncertain `ip_mismatch`) | `agent_unverified` | `crawler_unverified` |
| Verified WBA browser agent / IP-verified agent (`Claude-Agent`, `Google-Agent`) | `agent_verified` | `agent_verified` |
| Unverified agent token / unmapped token (`Blueno`) / unverified WBA / DOM marker | `agent_unverified` | `agent_unverified` |

## 0.4.5 — 2026-11-25

Vendor visitor-verdict-server 0.7.6 with startup directory revalidation and untrusted IP evidence protection.

## 0.4.4 — 2026-11-25

- Vendor visitor-verdict-server 0.7.5 with cold-directory recovery and complete per-verifier SAIL readiness.
- Synchronize the K7 contract, guard snapshots and 894 parity vectors.

## 0.4.3 — 2026-11-25

- Vendor visitor-verdict-server 0.7.4 and synchronize K6 boundary vectors and diagnostics.

## 0.4.2 — 2026-11-25

- Vendor visitor-verdict-server 0.7.3 with SAIL cache recovery and malformed-header fixes; refresh the shared differential corpus.

## 0.4.1 — 2026-11-25

- Pin Visitor Verdict server 0.7.2 with shared parity vectors.
- Shared differential corpus and regression coverage for K4.

## 0.4.0

- Review IP spoofing certainty: require every operator feed to have a known successful source refresh within 2 h; failures/cache reuse do not renew evidence. Uncertain mismatch preserves browser automated; exclusively non-WBA signatures allow IP fallback. Document TRUST_PROXY certainty.

- Bundle visitor-verdict-server 0.7.0. Add FLAG_SPOOFED_CLAIMS (off by default), trusted Fastify client-IP input, IP-feed warm-up and ip_mismatch health counts. Negative range evidence applies only to complete operator lists.
- Preserve verified session identity over mismatch spoofing (rank 4.5); document proxy configuration, evidence level and deployment checks.

## 0.3.0

- Keep v1 infrastructure echoes compatible with cached 0.2.0 clients by sending agent_verified + intermediary; internal/GA4 labels remain automation_verified. Freeze the original 0.2.0 reader/schema in a compatibility test fixture.
- Protect active direct browser identity from infrastructure/crawler storage and publication until proof expiry, including restored records and delayed responses. Verify bot counts and reserve ordinary-event claims; expand operator-source coverage for dom_host.

- Bundle visitor-verdict-server 0.6.1 from phase2-verifier 455e248 with recorded SHA-512 and npm integrity. Adopt narrower bot_spoofed outcomes and key refresh on mutable kid mismatch; Poppy remains optional and disabled.
- Add automation_verified for verified infrastructure at rank 4.75, retain legacy intermediary priority, and expose its counts. B7 schema v1 accepts the new type and publishes server_intermediary with the infrastructure operator; crawlers remain unpublished.
- Pass only dom_marker/dom_host browser provenance to visitorLabels as browserAgentClaim, preserving dom_host in vv_detail and dropping stale browser provenance when stronger session evidence wins.

## 0.2.0

- Echo bounded verified identities as HTTP 200 JSON with proof-limited TTL when verification is enabled; `VERDICT_ECHO=off` restores 204. Explicitly enable the browser reader only in collector-served scripts.
- Publish compatible Visitor Verdict server claims, upgrade DOM declarations, identify intermediary infrastructure with `server_intermediary`, and exclude crawlers from browser publications. Reset inherited score/signals, support script-selected and array-like layers, and allow corrected operator labels after restoration.
- Persist verified event responses only with analytics consent, cap session memory to proof expiry/30 minutes, and clear it on withdrawal without allowing pending readers to repopulate it. Keep ping persistence disabled and suppress echoes for withdrawn events. Document repeated agent-phase label events without changing GTM, delivery, retry or conversion handling.

## Unreleased

- Validate denied value as a finite JSON number and currency as three uppercase letters; strip browser vv labels and reject server claims from browser input. Reserve traffic_agent_claim on ordinary events.
- Retain ordinary retries and backoff when leaving a page or hiding a tab, release mature consent waiting on exit, and process verdict echoes for every event response.
- Stabilize retry proof fingerprints across unsigned cookie/proxy headers and runtime traffic labels while binding all signed headers and semantic event fields. Count obvious bots only on deliverable bot-labelled hits.
- Preserve conversion delivery by removing vv_detail, then vv_type, only after item trimming cannot bring a hit below 16 KiB.


- Label and forward obvious bot UAs by default; add opt-in legacy `FILTER_OBVIOUS_BOTS=on` and `botsLabelled` health counter.
- Hand pending conversions and class updates to keepalive transport on exit, share the two document phases across consent transports, and preserve class updates released after 30 seconds awaiting consent.
- Bind retry verdicts to an exact payload/request fingerprint after upstream failures; preserve rejection of signature replay for different events.
- Validate denied-ping JSON depth and preserve vv_type/vv_detail while trimming oversized item lists.
- Add optional `KEEP_QUERY_PARAMS` (empty by default) for retained URL markers such as vvp.
- Restrict denied pings to event name, URL/referrer, value, currency and Visitor Verdict fields in browser and collector. Omit items, transaction IDs and arbitrary custom data. Keep page title, IP, User-Agent and default URL cleaning unchanged; DENIED_PING_IP remains full and DENIED_PING_USER_AGENT remains on.


- Automatically send one Visitor Verdict `traffic_class` update per document on its first valid final/agent publication, including while hiding, with a best-effort keepalive fetch. Whitelist class/phase/operator, ignore initial/legacy phases and duplicates, preserve consent and cookieless ping rules, and keep normal event labels current. The collector admits the update independently of TRACKED_EVENTS, forwards those browser parameters plus vv labels to GA4 and refreshes session/page label memory. Upgrade the collector before the tracker; no retries or delivery guarantee. Document early-final and one-page suspicious carry in detector 1.2.0.

- Preserve verified purpose through session carry-over. Intermediary proof has rank 4.75, below direct verified agents/crawlers (5), so later Browserbase signatures cannot erase an active direct identity. Replay still labels only its hit as spoofed with no operator. Expand operator-source, purpose, expiry and replay regressions.
- Verifier 0.4.1 fixes intermediary masking of invalid signatures, repeated signature-header parsing, covered-member shape/type checks and lossy Decimal handling. Missing covered signature members fail verification; self-coverage is unsupported. Nothing is withheld by these labels.
- Upgrade egress: provisional Meta Muse adds muse.ai to startup key-directory hosts (five → six since verifier 0.4.0). Allow its HTTPS directory; blocking it can leave health at 5/6 with a failed refresh. The identity remains third-party-observed, not confirmed by Meta or a local request capture. Document removal of the old Browserbase purpose mapping.

- Bundle Visitor Verdict server 0.4.1: Meta Muse (`muse.ai`) as a signing operator; Browserbase reported as an intermediary (`vv_detail` purpose `intermediary`, agent not identified) and a valid direct signature preferred over it; outer signatures covering another label's signature (draft-01 Appendix D.2) verify; unlisted purposes become `unknown`. Analyst docs: count verified operators with vv_type `agent_verified` or `crawler_verified`; a UA token never names an operator. Amazon Bedrock AgentCore is documented as not supported (no public key directory).
- Read the optional page-marker operator `agent` (only `openai` or `anthropic`) and the phase `agent` from Visitor Verdict 1.1 and send it as `traffic_agent`; unknown values are dropped and older detectors send exactly what they sent before. The collector validates it the same way, reserves the name and passes it to the bundled Visitor Verdict server: without verified identity, a declared_agent hit names that operator in vv_detail with claim `dom_marker` and stays agent_unverified; a verified operator always wins, and when stronger session evidence supplies the operator the hit's claim reverts to its server claim. `traffic_agent` is sent only with declared_agent. A marker also qualifies for the one dedicated update when no final/agent update has been sent yet; otherwise it arrives with the next ordinary event or the next page. Update the collector before the tracker: an older collector forwards `traffic_agent` to GA4 as an ordinary parameter.
- Documentation: Vanilla only labels traffic. Nothing is held or excluded by default, including leads imported into Google Ads; filtering conversions is an optional choice.
- Use event-scoped vv_type/vv_detail from Visitor Verdict server 0.3.x and later; reserve old and new client label names and retain automatic/ecommerce fields within the 16 KiB limit.
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
