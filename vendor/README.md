# Visitor Verdict server package

- Source: https://github.com/Narrativva-Labs/visitor-verdict/tree/phase2-verifier/server
- Source commit: `6b61d91` (branch phase2-verifier).
- Version: 0.4.0; archive: visitor-verdict-server-0.4.0.tgz.
- SHA-512 (hex): `2be3e9f0aeadd2cfc4bb18d9284d8985f67e29434ee09ac277f1ab9d86d169325662657b680383de09fc853ce7ba5261376c80e7eaf917d2047375695d3fcd71`
- npm integrity: `sha512-K+Pp8K6t0s/EuxjZKE2JhfZ+KUNO4JrCd/GrnYbRaTJWYmV7aAOD3gn8hTznulJhN2yA5+r5F9IEc3VpXT/NcQ==`

Rebuild: `cd server && npm run build && npm pack`.
Copy the archive into vendor/, then run `npm install --offline ./vendor/visitor-verdict-server-0.4.0.tgz`.
Verify bytes using `shasum -a 512 vendor/visitor-verdict-server-0.4.0.tgz`.

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
