# Visitor Verdict server package

## 0.7.0 (current)

- Source: https://github.com/Narrativva-Labs/visitor-verdict/tree/42e1582/server (branch `ip-mismatch`, base commit `42e1582`; uncommitted review changes dated 2026-11-24: source-refresh certainty, automation precedence and non-WBA fallback).
- Archive: `visitor-verdict-server-0.7.0.tgz`.
- SHA-512 (hex): `aacd6da6a110206b75bd8bbcb20bf6ff655dc59429270cbc8931dd309b9ea6f5cb05ce6e292f6936390ba1961cad534aa6ad2f90c68ba65ba5a99f8c87cf5288`
- npm integrity: `sha512-qs1tpqEQIGt1vYu8sgv2/2VdxZQpJwy8iTHdMJuepvXLBc5uKS9pNjkLoZYcrVNKpq0vkMaLplulqZ+Mh89SiA==`

Verify with `shasum -a 512 vendor/visitor-verdict-server-0.7.0.tgz`.
Install with `npm install --offline ./vendor/visitor-verdict-server-0.7.0.tgz`.
Rebuild from the source worktree including the review changes with `cd server && npm ci && npm run build && npm pack`.

Review revision: `bot_spoofed` requires trusted IP plus known successful refresh
of every operator feed within 2 h. Uncertain mismatch preserves browser automated;
exclusively non-WBA signatures allow IP fallback.

Adds opt-in unsigned UA `ip_mismatch`, explicit OpenAI feed completeness,
`ipTrusted`, and memory-only negative checks with ten-minute background refresh.
See README/INSTALL for FLAG_SPOOFED_CLAIMS and trusted proxy deployment checks.
Older archives are retained for provenance; only 0.7.0 is selected by the manifest
and lockfile.


## Previous archive: 0.6.1

- Source: https://github.com/Narrativva-Labs/visitor-verdict/tree/455e248/server (branch `phase2-verifier`, commit `455e248`).
- Version: 0.6.1; archive: `visitor-verdict-server-0.6.1.tgz`.
- SHA-512 (hex): `9a333183229b97d7e88bb39b3592529bcc0c1be4de729a7190f54c50989887ea0c72ae89c54c791fa59a15442aa55bd20198a9e501ebc5389d0719493b4f1b23`
- npm integrity (package-lock.json): `sha512-mjMxgyKbl9foi7ObNZJSm8wMG+TecppxkPVMUJiYh+oMcq6JxUx5H6WaFUQqpVvSAZip5QHrxTidBxlJO08bIw==`

Verify with `shasum -a 512 vendor/visitor-verdict-server-0.6.1.tgz`.
Install this archive with `npm install --offline ./vendor/visitor-verdict-server-0.6.1.tgz`.
Rebuild at the source commit with `cd server && npm run build && npm pack`.

Changes from 0.5.1:

- `bot_spoofed` is narrower: only a definitive cryptographic mismatch against a known declared key yields `signature_invalid`. Replay, expiration, malformed/truncated signatures and incomplete context stay unverified (`none`). Vanilla keeps retry proof binding and prevents replay hits from inheriting sticky verified identity.
- In request mode a cached mutable `kid` gets a throttled directory refresh on crypto mismatch. Vanilla retains cache-only verification: a known-kid mismatch stays indeterminate and does not start a mismatch fetch; a normal background directory refresh can provide the rotated key. Unknown/inactive keys still trigger asynchronous refresh. The refreshed key can verify the next hit. A mismatch against a freshly fetched document is definitive; immutable thumbprint keys need no rotation fallback.
- Verified intermediary infrastructure now has its own `automation_verified` type. Vanilla ranks it at 4.75, between spoofing evidence (4.5) and direct agent/crawler identity (5); legacy `agent_verified` + purpose `intermediary` has the same priority. B7 schema v1 transports the backwards-compatible `agent_verified` + `intermediary` shape; both old and current clients publish `declared_agent` with `server_intermediary` and the infrastructure operator. Internal and GA4 types remain `automation_verified`.
- `browserAgentClaim` distinguishes observed `dom_host` from `dom_marker`. Vanilla accepts only these browser claims, strips server claims from browser input, and removes browser provenance when stronger sticky evidence supplies identity.
- Poppy 1.0 verification is optional and off by default. The library supports pinned Muse metadata/JWKS and `poppy_session` evidence; Vanilla does not enable Poppy or add a configuration switch in this upgrade. Its existing nine-directory WBA warm-up is unchanged.

The previous archive is retained for provenance; package.json and the lockfile select only 0.6.1.

## Previous archive: 0.5.1

- Source: https://github.com/Narrativva-Labs/visitor-verdict/tree/main/server
- Source: working tree based on `fbfaa30` (branch phase2-verifier); 0.5.1 changes remain uncommitted for owner review.
- Version: 0.5.1; archive: visitor-verdict-server-0.5.1.tgz.
- SHA-512 (hex): `7b97faa2eab79eb762e967316a75a2ee4cf00b4757c80c0c76bd831386c97803de2ec1a02560a8fd18e3193e4a9732ccd1a18e5b6def93a1c7452e53037bdf33`
- npm integrity: `sha512-e5f6ouq3nrdi6WcxanWi7kzwC0dXyAwMdr2DE4bJeAPeLsGgJWCo/RjjGT5KlzLM0aGOW23vk6HHRS5TA3vfMw==`

Rebuild: `cd server && npm run build && npm pack`.
Copy the archive into vendor/, then run `npm install --offline ./vendor/visitor-verdict-server-0.5.1.tgz`.
Verify bytes using `shasum -a 512 vendor/visitor-verdict-server-0.5.1.tgz`.

Version 0.3.0 replaces toAnalyticsFields with pure visitorLabels. Vanilla sends only
vv_type and vv_detail to GA4; browser traffic_class/traffic_phase remain collector
inputs. No raw claims or diagnostic request data are exported in these labels.

Version 0.3.3 fixes replay failure ordering, adds bounded per-operator replay budgets
and status, and retains replay evidence through an absolute skew deadline.

Version 0.3.4 preserves typed failures across independent package copies and
reclaims expired replay occupancy when status is read using the shared clock.

Version 0.3.5 accepts an optional browser page-marker operator (`browserAgent`, only
openai or anthropic) and the browser phase `agent`. Without a verified identity or an
invalid signature, a marker with class declared_agent names the operator in vv_detail
with claim `dom_marker`; the type stays agent_unverified. Verified identity always wins.

Version 0.4.0 adds Meta Muse (`https://muse.ai`) as a signing operator, reports
Browserbase as an intermediary (purpose `intermediary`: verified signing
infrastructure, not the agent) and prefers a valid direct signature over it,
verifies outer signatures that cover another label's signature (draft-01
Appendix D.2), and maps unlisted purposes to `unknown`. Only verification or a
page marker names an operator in vv_detail; a UA token never does.

Version 0.4.1 prevents an intermediary from hiding another label's invalid signature
or replay, parses signature dictionaries once per request, validates covered member
shapes, and treats lossy Decimal inputs as indeterminate. Missing covered signature
members fail verification. Infrastructure purpose survives Vanilla session carry-over;
its session rank (4.75) cannot replace a direct verified identity (5). PurposePolicy
excludes intermediary, which is configured only by the registry flag.

The provisional Muse entry raised startup directories from five to six in 0.4.0.
Allow outbound HTTPS to muse.ai or health may show 5/6 with a failed refresh. This
identity remains third-party-observed, not confirmed by Meta or a local capture.

Version 0.5.1 adds optional local header_mismatch diagnostics for scoped Chromium
navigation/resource claims. It does not change visitor labels, identity or purpose.
Original rawHeaders already reach verification and TRUST_PROXY rules are unchanged.
Kernel Agent (`kernel`), Cloudflare Browser Run (`cloudflare_browser_run`) and
Shopify Cloudsurf (`shopify_cloudsurf`) are admitted as intermediary signers after
primary-source checks and owner-supplied live directories (2026-11-23). All five
Ed25519 authority-binding proofs verify; these do not bind the directory body.
No signed visitor requests were captured. Startup now expects nine directories;
add HTTPS egress to www.kernel.sh,
web-bot-auth.cloudflare-browser-rendering-085.workers.dev and cloudsurf.shopify.io.
Each uses /.well-known/http-message-signatures-directory. Kernel nbf/exp are checked
per use. Verified signatures name infrastructure, never a customer's agent.
The archive README records exact identities, directory URLs and sources.

Version 0.5.1 corrects header diagnostic version/scope exclusions and provides
secure/headerDiagnostics adapter opt-outs. Unknown/inactive keys remain indeterminate
and refresh asynchronously under cacheOnly. Kernel runtime nbf/exp rotation and mixed
intermediary failures have regression coverage. Corporate workers.dev blocking and
preview hostname lifecycle require deployment review. Split agent_verified by the
intermediary purpose segment in analytics. No local evidence is exported or logged.
