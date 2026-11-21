# Visitor Verdict server package

- Source: https://github.com/Narrativva-Labs/visitor-verdict/tree/phase2-verifier/server
- Source commit: `9af4798` (branch phase2-verifier).
- Version: 0.3.3; archive: visitor-verdict-server-0.3.3.tgz.
- SHA-512 (hex): `711caa01125bbd3f167f64541f4b9b60758ed213ad530769d5a0b2deed1c5129ed1b9c058e94adcf9264bc1624ba14f3a1c1e1af12fe1daefc0cd63bccbc7db3`
- npm integrity: `sha512-cRyqARJbvT8Wf2RUH0ubYHWO0hOtUwdp1aCy3u0cUSntG5wFjpStz5JkvBYkuhTzocHhrxL+Ha78DNY7zLx9sw==`

Rebuild: `cd server && npm run build && npm pack`.
Copy the archive into vendor/, then run `npm install --offline ./vendor/visitor-verdict-server-0.3.3.tgz`.
Verify bytes using `shasum -a 512 vendor/visitor-verdict-server-0.3.3.tgz`.

Version 0.3.1 replaces toAnalyticsFields with pure visitorLabels. Vanilla sends only
vv_type and vv_detail to GA4; browser traffic_class/traffic_phase remain collector
inputs. No raw claims or diagnostic request data are exported in these labels.

Version 0.3.3 fixes replay failure ordering, adds bounded per-operator replay budgets
and status, and retains replay evidence through an absolute skew deadline.
