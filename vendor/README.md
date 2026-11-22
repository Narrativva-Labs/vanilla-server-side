# Visitor Verdict server package

- Source: https://github.com/Narrativva-Labs/visitor-verdict/tree/phase2-verifier/server
- Source commit: `33ec562` (branch phase2-verifier).
- Version: 0.3.5; archive: visitor-verdict-server-0.3.5.tgz.
- SHA-512 (hex): `75d4526f1103e0c0b98612b85f172fc925f23f706a00f1361d338e3f107fcff3707e424b3b35b142243def880fe96e74a097f5a0c66cfb524ad31f65e1cca96a`
- npm integrity: `sha512-ddRSbxED4MC5hhK4XxcvySXyP3BqAPE2HTOOPxB/z/NwfkJLOzWxQiQ974gP6W50oJf1oMZs+1JK0x9l4cypag==`

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
