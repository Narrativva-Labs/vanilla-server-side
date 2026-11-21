# Visitor Verdict server package

- Source: https://github.com/Narrativva-Labs/visitor-verdict/tree/phase2-verifier/server
- Source commit: `a51b3b5` (branch phase2-verifier).
- Version: 0.3.4; archive: visitor-verdict-server-0.3.4.tgz.
- SHA-512 (hex): `ef47a121e3e7625c2ef8482d9cf9ffa3fa8b7a015bbef64aa2f87d69383b28cb5f12a6a973551a64a349e55616b45ac2a4291abd5afaa5c60e1fa14fb766c565`
- npm integrity: `sha512-70ehIePnYlwu+EgtnPn/o/qLegFbvvZKovh9aTg7KMtfEqapc1UaZKNJ5VYWtFrCpCkavVr6pcYOH6FPt2bFZQ==`

Rebuild: `cd server && npm run build && npm pack`.
Copy the archive into vendor/, then run `npm install --offline ./vendor/visitor-verdict-server-0.3.4.tgz`.
Verify bytes using `shasum -a 512 vendor/visitor-verdict-server-0.3.4.tgz`.

Version 0.3.0 replaces toAnalyticsFields with pure visitorLabels. Vanilla sends only
vv_type and vv_detail to GA4; browser traffic_class/traffic_phase remain collector
inputs. No raw claims or diagnostic request data are exported in these labels.

Version 0.3.3 fixes replay failure ordering, adds bounded per-operator replay budgets
and status, and retains replay evidence through an absolute skew deadline.

Version 0.3.4 preserves typed failures across independent package copies and
reclaims expired replay occupancy when status is read using the shared clock.
