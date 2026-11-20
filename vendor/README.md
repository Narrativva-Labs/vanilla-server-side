# Visitor Verdict server package

- Source: https://github.com/Narrativva-Labs/visitor-verdict/tree/phase2-verifier/server
- Source commit: `a5ce30c870a9ea9a482e37db7b33e81ed52678ed` (branch phase2-verifier).
- Version: 0.3.1; archive: visitor-verdict-server-0.3.1.tgz.
- SHA-512 (hex): `783899d4231768030f8179addded124c37679f7210ebf3d0a0d96bcf3563e4ea868bbd66ceb314caee6929425c838e3fc07a9f3540576d1b5967e603be3eab0f`
- npm integrity: `sha512-eDiZ1CMXaAMPgXmt3e0STDdnn3IQ6/PQoNlrzzVj5OqGi71mzrMUyu5pKUJcg44/wHqfNUBXbRtZZ+YDvj6rDw==`

Rebuild: `cd server && npm run build && npm pack`.
Copy the archive into vendor/, then run `npm install --offline ./vendor/visitor-verdict-server-0.3.1.tgz`.
Verify bytes using `shasum -a 512 vendor/visitor-verdict-server-0.3.1.tgz`.

Version 0.3.1 replaces toAnalyticsFields with pure visitorLabels. Vanilla sends only
vv_type and vv_detail to GA4; browser traffic_class/traffic_phase remain collector
inputs. No raw claims or diagnostic request data are exported in these labels.
