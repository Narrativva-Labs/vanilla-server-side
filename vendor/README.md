# Visitor Verdict server package

- Source: https://github.com/Narrativva-Labs/visitor-verdict/tree/phase2-verifier/server
- Source: working tree based on `fa9c422dde5796dea22dd2a07d2994e4e6ece29e` (branch phase2-verifier); 0.5.0 changes remain uncommitted for owner review.
- Version: 0.5.0; archive: visitor-verdict-server-0.5.0.tgz.
- SHA-512 (hex): `871735de611f5a3f967af72b2ab4c0faafaf959989177ac428bfdd5ae35d05b18c583e5a5113c6df44c08e498d62923095371d14591de32ca656d486eda90849`
- npm integrity: `sha512-hxc13mEfWj+WevcrKrTA+q+vlZmJF3rEKL/dWuNdBbGMWD5aURPG30TAjkmNYpIwlTcdFFkd4yymVtSG7akISQ==`

Rebuild: `cd server && npm run build && npm pack`.
Copy the archive into vendor/, then run `npm install --offline ./vendor/visitor-verdict-server-0.5.0.tgz`.
Verify bytes using `shasum -a 512 vendor/visitor-verdict-server-0.5.0.tgz`.

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

Version 0.5.0 adds optional local header_mismatch diagnostics for scoped Chromium
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
