# Vanilla Server-Side

**[Install it](INSTALL.md)** | **[Understand how it works](docs/technical-overview.md)**

A small, self-hosted analytics collector by František Bujnovský. Your regular Google Analytics stays exactly as it is. Next to it, a tiny script sends events to your own server, and your server forwards them to a **second, separate** Google Analytics property through the documented Measurement Protocol.

You get a second measurement under your own control: a signed cookie set by your server, a consent check on your server, and the Google API secret kept off the website. The server checks the consent state the browser reports and cannot confirm it independently, and the data still ends up in Google Analytics. It runs on a small VPS with no database. MIT licensed.

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

Open http://localhost:3210. The page has a small consent bar (accept, reject, withdraw) and buttons for `page_view`, `generate_lead` and `purchase`. The real tracker and collector run, with Google replaced by a local stub. The terminal shows what would go to Google and what was blocked.

## Consent

| Visitor | What happens |
| --- | --- |
| Analytics granted | Send |
| No decision yet, no consent signal | Hold in memory for up to 2 seconds, then drop |
| No decision yet, `default` or `update` denied | Send nothing |
| Analytics denied | Stop, clear the queue, delete the cookie |

After consent the identity is a random ID in a signed server cookie, the one first-party `HttpOnly` cookie this project stores, and the visitor IP is passed as `ip_override` for geography. Before consent there is no cookie and nothing is sent.

Supported out of the box:

- direct `gtag("consent", ...)` commands
- [Cookiebot](https://www.cookiebot.com/)
- [CookieConsent by Orest Bida](https://github.com/orestbida/cookieconsent)
- [CookieYes](https://www.cookieyes.com/)
- the built-in Shoptet cookie bar

The tracker reads these banners by itself, without integration code, and a decided banner beats Google's default consent. The conditions: custom CookieConsent categories need attributes on the script tag, a Google `update` already on the page is not overridden by the banner's state at load, and consent held only inside Google Tag Manager cannot be read. See [connecting your banner](INSTALL.md#connect-your-consent-banner) and [what banners really send](docs/cookie-banners.md).

## Limits

- **Partial reporting.** Google says Measurement Protocol alone gives [only partial reporting](https://developers.google.com/analytics/devguides/collection/protocol/ga4). Expect source, session and user reports to differ from the regular property.
- **New users will probably show 0.** `first_visit` is reserved and cannot be sent, and the validator rejects it. Effect on the report: Not verified.
- **Safari kept the cookie for 7 days in the one run measured.** Safari 26.6.2 stored it for 7.0 days with the tracker on a different IPv4 /16 from the website, the case [WebKit's cap](https://webkit.org/blog/15697/private-browsing-2-0/) describes. A default install runs on a different server, so expect the same. The server renews the cookie on each delivered event; whether a returning visitor keeps the identity in Safari: Not verified. [Details](docs/technical-overview.md#safari).
- **Content blockers.** Getting past them is a side benefit, not the purpose of this project. A neutral random subdomain and neutral paths lower the chance of a filter list match, but guarantee nothing: first-party does not mean unblockable. In one run, uBlock Origin Lite with default lists did not stop the tracker. Consent rules stay the same: nothing is sent without consent, and a refusal stops collection. [Details](docs/technical-overview.md#content-blockers).
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

For development on Node 24: `npm ci && npm test && npm run typecheck && npm run build`. `npx playwright install chromium webkit && npm run test:e2e` runs the consent flow in real browsers. `npm run verify:mp` checks real payloads against Google's validation server and sends nothing to reports.

Found a security issue? See [SECURITY.md](SECURITY.md).
