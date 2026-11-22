# Visitor Verdict server package

- Source: https://github.com/Narrativva-Labs/visitor-verdict/tree/phase2-verifier/server
- Source commit: `b26d745` (branch phase2-verifier).
- Version: 0.3.5; archive: visitor-verdict-server-0.3.5.tgz.
- SHA-512 (hex): `98a8149ed8f735e3ccdec2d0645031003e886c681f566198262dda686a2b7a3f950bc164846b40df0dff68b033d46027ede4395840a11d6f7e0f5623e39776c0`
- npm integrity: `sha512-mKgUntj3NePM3sLQZFAxAD6IbGgfVmGYJi3aaGorej+VC8FkhGtA3w3/aLAz1GAn7eQ5WEChHW9+D1Yj45d2wA==`

Rebuild: `cd server && npm run build && npm pack`.
Copy the archive into vendor/, then run `npm install --offline ./vendor/visitor-verdict-server-0.3.5.tgz`.
Verify bytes using `shasum -a 512 vendor/visitor-verdict-server-0.3.5.tgz`.

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
