# Security

## Reporting a vulnerability

Please report security issues privately through [GitHub private vulnerability reporting](https://github.com/Narrativva-Labs/vanilla-server-side/security/advisories/new), not in a public issue. Include the affected version or commit, the steps to reproduce it and the impact you expect.

This is a personal open source project without a support contract, so response times are best effort.

## Supported versions

Only the latest commit on `main` is supported. There are no maintained release branches.

## In scope

- Bypassing the consent checks, for example sending an event or setting a cookie after refusal
- Forging or tampering with the signed identity cookie
- Exposing the Measurement Protocol API secret or `COOKIE_SECRET`
- Code injection through the tracker, the collector or the install scripts
- Logging or forwarding personal data beyond what the documentation describes

## Out of scope

- Fake events sent directly to a public collector. The endpoint is public by design and `Origin` can be forged outside a browser, so the collector limits abuse but cannot prove that an event is real
- Limits already listed in the [README](README.md) and the [technical overview](docs/technical-overview.md)
- Problems in Google Analytics, consent banners or your own server configuration

## If you run an instance

- Keep `.env` private and never commit it
- Rotate the API secret and `COOKIE_SECRET` if you suspect a leak. Rotating `COOKIE_SECRET` resets visitor identities
- Keep the server, Docker and this repository up to date. `s.js` runs on your website, so a compromised server can affect your visitors
