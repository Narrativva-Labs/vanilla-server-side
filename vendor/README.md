# Visitor Verdict server package

- Source: https://github.com/Narrativva-Labs/visitor-verdict/tree/phase2-verifier/server
- Source commit: `4d0903e` (branch phase2-verifier).
- Version: 0.3.2; archive: visitor-verdict-server-0.3.2.tgz.
- SHA-512 (hex): `fcf1cdfc5b9457baf3a7f96b116946bf65a8648d036edd5e5a49fc1ddb89e530cfe77f71a983d776497b7426bc4d4871e152cbcf28a624960c9eedc8764a4c39`
- npm integrity: `sha512-/PHN/FuUV7rzp/lrEWlGv2WoZI0Dbt1eWkn8HduJ5TDP539xqYPXdkl7dCa8TUhx4VLLzyimJJYMnu3IdkpMOQ==`

Rebuild: `cd server && npm run build && npm pack`.
Copy the archive into vendor/, then run `npm install --offline ./vendor/visitor-verdict-server-0.3.2.tgz`.
Verify bytes using `shasum -a 512 vendor/visitor-verdict-server-0.3.2.tgz`.

Version 0.3.1 replaces toAnalyticsFields with pure visitorLabels. Vanilla sends only
vv_type and vv_detail to GA4; browser traffic_class/traffic_phase remain collector
inputs. No raw claims or diagnostic request data are exported in these labels.

Version 0.3.2 adds local atomic replay enforcement and signed proof expiry metadata.
