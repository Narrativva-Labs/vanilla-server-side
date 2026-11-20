# Visitor Verdict server package

- Source: https://github.com/Narrativva-Labs/visitor-verdict/tree/phase2-verifier/server (not yet merged into main)
- Source commit: `63473f2c56c2e66d538a06d31dd28ce8a3c8f00c` (branch phase2-verifier).
- Version: 0.2.0; archive: visitor-verdict-server-0.2.0.tgz.
- SHA-512 (hex): `f00912abee67a7ed664ebbd1711455954d90b0aa1e7c0d3fd38a50b77e31318026da9b5e11946987be17199d8fe52c96aadfe285b3ba5486f7899b6b7ff83dd3`
- npm integrity: `sha512-8AkSq+5np+1mTrvRcRRVlU2QsKoefA0/04pQt34xMYAm2pteEZRph74XGZ2P5SyWqt/ihbO6VIb3iZtrf/g90w==`

Rebuild from the matching source checkout: `cd server && npm run build && npm pack`.
Copy the resulting tarball to vendor/, then run `npm install --offline ./vendor/visitor-verdict-server-0.2.0.tgz` to refresh the lockfile.

Verify bytes: `shasum -a 512 vendor/visitor-verdict-server-0.2.0.tgz` must match the hex digest above.
`node -e "const f=require('node:fs'),c=require('node:crypto');console.log('sha512-'+c.createHash('sha512').update(f.readFileSync('vendor/visitor-verdict-server-0.2.0.tgz')).digest('base64'))"` must match npm integrity in package-lock.json.
A rebuilt archive may differ if its source content differs; verify against this recorded archive before installing.
