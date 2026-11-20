# Visitor Verdict server package

- Source: https://github.com/Narrativva-Labs/visitor-verdict/tree/phase2-verifier/server
- Source commit: `6938422dda698f550dffa3820f6c7e9467689c2f` (branch phase2-verifier).
- Version: 0.3.0; archive: visitor-verdict-server-0.3.0.tgz.
- SHA-512 (hex): `b93b4b45cfb77f0bc6777ca2915469575a5eb8cc89ef8d4023863fa13d99d5d281cad6c20bbbc336535ab191cc3a5fc3077b84aaa9bb51800654ed89e0f889c1`
- npm integrity: `sha512-uTtLRc+3fwvGd3yikVRpV1peuMyJ741AI4Y/oT2Z1dKBytbCC7vDNlNasZHMOl/DB3uEqqm7UYAGVO2J4PiJwQ==`

Rebuild: `cd server && npm run build && npm pack`.
Copy the archive into vendor/, then run `npm install --offline ./vendor/visitor-verdict-server-0.3.0.tgz`.
Verify bytes using `shasum -a 512 vendor/visitor-verdict-server-0.3.0.tgz`.

Version 0.3.0 replaces toAnalyticsFields with pure visitorLabels. Vanilla sends only
vv_type and vv_detail to GA4; browser traffic_class/traffic_phase remain collector
inputs. No raw claims or diagnostic request data are exported in these labels.
