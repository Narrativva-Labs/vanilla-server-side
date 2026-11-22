# Visitor Verdict server package

- Source: https://github.com/Narrativva-Labs/visitor-verdict/tree/phase2-verifier/server
- Source commit: `fa9c422` (branch phase2-verifier).
- Version: 0.4.1; archive: visitor-verdict-server-0.4.1.tgz.
- SHA-512 (hex): `50751f830c77dc22bd497aaea66c1fc88e18a82bdd61e3e8bd61ca751e29fa3b9abf2594ed760ca3ef31a7f2c0670db57f615387da74e042db14e0e4b1f77b4f`
- npm integrity: `sha512-UHUfgwx33CK9SXqupmwfyI4YqCvdYePovWHKdR4p+juavyWU7XYMo+8xp/LAZw21f2FTh9p04ELbFODksfd7Tw==`

Rebuild: `cd server && npm run build && npm pack`.
Copy the archive into vendor/, then run `npm install --offline ./vendor/visitor-verdict-server-0.4.1.tgz`.
Verify bytes using `shasum -a 512 vendor/visitor-verdict-server-0.4.1.tgz`.

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
