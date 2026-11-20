# Visitor Verdict server package

- Source: https://github.com/Narrativva-Labs/visitor-verdict/tree/phase2-verifier/server
- Source commit: `ef80dbfcc7425464ba44d434681ea1125b711d36` (branch phase2-verifier)
- Version: 0.2.1; archive: visitor-verdict-server-0.2.1.tgz.
- SHA-512 (hex): `4aeab86b788072a648c88e4302c293ee0345cf43621b2b6fefc447c8dcf4a5e19fb5f76251ccaaf4fef8fd87bea4350cb526a6393d26f24588df3941ed12f53e`
- npm integrity: `sha512-Suq4a3iAcqZIyI5DAsKT7gNFz0NiGytv78RHyNz0peGftfdiUcyq9P74/Ye+pDUMtSamOT0m8kWI3zlB7RL1Pg==`

Rebuild: `cd server && npm run build && npm pack`.
Copy the archive into vendor/, then run `npm install --offline ./vendor/visitor-verdict-server-0.2.1.tgz`.
Verify bytes using `shasum -a 512 vendor/visitor-verdict-server-0.2.1.tgz`.
