# Vendored Visitor Verdict server 0.7.6

Source: visitor-verdict-ipmismatch/server, branch ip-mismatch. Locally built K8 worktree; no commit or tag was created. Both consumers use the identical unpatched npm archive.

SHA-512:

```text
651f78087361afe2fbf56b0f6271b0e369e94e8fef050bd16ea64b42da6ec42a1c03b9906875043d5b6f19a5da9470df80697a13ca0229e537ba10b25abd6a1c
sha512-ZR94CHNhr+L79WsPYnGw42npTo/vBQvRbqZLQtpuxCocA7mQaHUEPVtvGaXalHDfgGl6E8oCKeU3uhCyWr1qHA==
```

Build: npm run build; npm pack from server/. Dependencies remain pinned in package-lock.json; the service vendor/npm-cache supports an offline Docker build. No new registry dependency was introduced in K8.
