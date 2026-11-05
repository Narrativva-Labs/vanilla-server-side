# Vanilla Server-Side

**[Install it](INSTALL.md)** | **[Understand how it works](docs/technical-overview.md)**

A small, self-hosted analytics collector by František Bujnovský. Your regular Google Analytics stays exactly as it is. Next to it, a tiny script sends events to your own server, and your server forwards them to a **second, separate** Google Analytics property through the documented Measurement Protocol.

You get a second measurement that you own end to end: a signed cookie set by your server, your consent rules enforced on your server, and the Google API secret kept off the website. It runs on a small VPS with no database. MIT licensed.

```text
Browser -- regular Google tag / GTM -----------------> regular property (unchanged)
   |
   `-- Vanilla script --> your server --------------> second property
        waits for consent   signed cookie              Measurement Protocol
                            consent check              API secret stays here
                            bot filter
```

Use the second property for Vanilla only. Never point it at the property your regular tag uses: nothing deduplicates the two streams.

## Quick start

You need a domain, a Google Analytics account and an Ubuntu or Debian VPS. [INSTALL.md](INSTALL.md) walks through each step without assuming server experience.

```sh
git clone https://github.com/Narrativva-Labs/vanilla-server-side.git
cd vanilla-server-side
./install.sh
```

Then add the one script tag the installer prints:

```html
<script defer src="https://kx7qpa.example.com/s.js"></script>
```

## Try it first

No account and no server. It needs Node 22.12 or 24, and after `npm ci` it runs offline.

```sh
npm ci
npm run demo
```

Open http://localhost:3210. The page has a small consent bar (accept, reject, withdraw) and buttons for `page_view`, `generate_lead` and `purchase`. The real tracker and collector run, with Google replaced by a local stub. The terminal shows what would go to Google and what was blocked. `TRACKING_MODE=cookieless npm run demo` shows the other mode.

## Modes

| | Cookie (default) | Cookieless |
| --- | --- | --- |
| Analytics granted | Send | Send |
| No decision yet | Hold in memory for up to 2 seconds, then drop | Hold for up to 2 seconds, then send with advertising denied |
| Analytics denied | Stop, clear the queue, delete the cookie | Stop, clear the queue |
| Identity | Random ID in a signed server cookie | Random ID in page memory only |
| Storage | One first-party `HttpOnly` cookie | No cookies, no browser storage |
| Geography | Visitor IP passed as `ip_override` after consent | IP is not passed |

Cookiebot, CookieConsent, CookieYes, Shoptet and direct `gtag("consent", ...)` commands are read automatically. See [connecting your banner](INSTALL.md#connect-your-consent-banner) and [what banners really send](docs/cookie-banners.md).

## Limits

- **Partial reporting.** Google says Measurement Protocol alone gives [only partial reporting](https://developers.google.com/analytics/devguides/collection/protocol/ga4). Expect source, session and user reports to differ from the regular property.
- **New users will probably show 0.** `first_visit` is reserved and cannot be sent, and the validator rejects it. Effect on the report: Not verified.
- **Safari will probably keep the cookie for 7 days only.** A default install runs on a different server from your website, which falls under [WebKit's cap](https://webkit.org/blog/15697/private-browsing-2-0/). The cookie is renewed on each visit.
- **Content blockers.** The goal is control over data and consent, not getting past blockers. Nothing here promises that. [Position](docs/technical-overview.md#content-blockers).
- **Bots.** A short User-Agent filter stops obvious ones. Anything that claims to be a browser passes.
- **No Google Ads integration**, cross-domain identity, durable queue or backfill. If your server is down, its events are lost; the regular tag is unaffected.
- **HTTP 2xx proves delivery only.** Google [does not report errors](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference) on the live endpoint.
- **No legal guarantee.** Choose consent behavior and disclosures that fit your site.

## Links

- [INSTALL.md](INSTALL.md): step-by-step setup, consent, verification, updates
- [Technical overview](docs/technical-overview.md): architecture, identity, consent state machine, prior art
- [Measurement Protocol notes](docs/measurement-protocol-notes.md): what the docs say against what the validator and Realtime showed
- [Cookie banners](docs/cookie-banners.md): what consent banners really send
- [Design decisions](docs/decisions.md): each decision with its alternative and source

For development on Node 24: `npm ci && npm test && npm run typecheck && npm run build`. `npm run verify:mp` checks real payloads against Google's validation server and sends nothing to reports.
