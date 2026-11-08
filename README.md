# Vanilla Server-Side

**[Install it](INSTALL.md)** | **[Understand how it works](docs/technical-overview.md)**

A small, self-hosted analytics collector by František Bujnovský. Your regular Google Analytics stays exactly as it is. Next to it, a tiny script sends events to your own server, and your server forwards them to a **second, separate** Google Analytics property. Every event uses `/g/collect`, the transport used by the Google tag.

It measures for Google Analytics only and sends nothing to Meta or other platforms.

Need this set up, or your measurement reviewed? I do that as paid work: [frantisekbujnovsky.com](https://frantisekbujnovsky.com).

You get a second measurement under your own control: a signed cookie set by your server, a consent check on your server, and one Google transport for sessions and purchases. The server checks the consent state the browser reports and cannot confirm it independently, and the data still ends up in Google Analytics. It runs on a small VPS with no database. MIT licensed.

```text
Browser -- regular Google tag / GTM -----------------> regular property (unchanged)
   |
   `-- Vanilla script --> your server --------------> second property
        waits for consent   signed cookie              /g/collect for every event
                            consent check              session flags on the first hit
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

Page views then work by themselves. Other events are read from `dataLayer`, not from GTM tags, so they must already carry their GA4 names and parameters there.

## Try it first

No account and no server. It needs Node 22.12, 24 or 26, and after `npm ci` it runs offline.

```sh
npm ci
npm run demo
```

Open http://localhost:3210. The page has a small consent bar (accept, reject, withdraw) and buttons for `page_view`, `generate_lead` and `purchase`. The real tracker and collector run, with Google replaced by a local stub. The terminal shows what would go to Google and what was blocked.

## Consent

| Visitor | What happens |
| --- | --- |
| Analytics granted | Send |
| No decision yet | Nothing sent. Events wait in memory and go out after a grant; a refusal or leaving the page drops them. With a `default` denied, one limited ping per page |
| Analytics denied | Stop, clear the queue, delete the cookie. One limited ping per page, unless consent already measured that page |

After consent the identity is a random ID in a signed server cookie, the one first-party `HttpOnly` cookie this project stores, and the visitor IP is passed to Google for geography. Without consent there is no cookie and no regular event is sent, only one limited ping when the state is denied.

A page that stays denied for 2 seconds sends that ping, the way the Google tag does in [Advanced Consent Mode](https://developers.google.com/tag-platform/security/concepts/consent-mode): a one-off ID, no cookie, no visitor IP and no click IDs, with the denied state in `gcs` and `gcd`. It carries the cleaned page URL, referrer, title, language, screen size and the browser's `User-Agent` header. Your own server still receives the request, with the visitor's IP address, for the rate limit. A URL path or title can hold personal data, because the cleaning removes only query parameters, fragments and credentials, so "limited" does not mean anonymous. Disclose this on your site, or set `DENIED_PINGS=off`. Whether a ping changes any report: Not verified.

Supported out of the box:

- direct `gtag("consent", ...)` commands
- [Cookiebot](https://www.cookiebot.com/)
- [CookieConsent by Orest Bida](https://github.com/orestbida/cookieconsent)
- [CookieYes](https://www.cookieyes.com/)
- the built-in Shoptet cookie bar

The tracker reads these banners by itself, without integration code, and a decided banner beats Google's default consent. The conditions: custom CookieConsent categories need attributes on the script tag, a Google `update` already on the page is not overridden by the banner's state at load, and consent held only inside Google Tag Manager cannot be read. See [connecting your banner](INSTALL.md#connect-your-consent-banner) and [what banners really send](docs/cookie-banners.md).

## Google Ads

The server talks only to Google Analytics. Google Ads reaches the data the usual way: link the second property to Ads and import its key events as conversions. For that, the landing page's `gclid`, `gbraid` or `wbraid` goes to Google in the first hit, and only when `ad_storage` and `ad_user_data` are both granted. Without them the click ID stays in the browser.

If the regular property already imports the same conversion, set this one as secondary, or it counts twice. A conversion credited to a real ad click: Not verified yet. Steps are in [INSTALL.md](INSTALL.md#optional-import-conversions-into-google-ads).

## Limits

- **Reporting can differ from the regular tag.** In the November 7–8 comparison, collect kept all tested hits in the attributed session; mixed transport lost attribution on some MP events. See the [test notes](docs/measurement-protocol-notes.md#all-collect-comparison).
- **`/g/collect` has no public contract.** Google can change it without notice, and it returns 204 for anything. The fields follow captured Google tag hits, so they need a recheck over time. See the [notes](docs/measurement-protocol-notes.md#gcollect).
- **Safari kept the cookie for 7 days in the one run measured.** Safari 26.6.2 stored it for 7.0 days with the tracker on a different IPv4 /16 from the website, the case [WebKit's cap](https://webkit.org/blog/15697/private-browsing-2-0/) describes. A default install runs on a different server, so expect the same. The server renews the cookie on each delivered event; whether a returning visitor keeps the identity in Safari: Not verified. [Details](docs/technical-overview.md#safari).
- **Content blockers.** Getting past them is a side benefit, not the purpose of this project. A neutral random subdomain and neutral paths lower the chance of a filter list match, but guarantee nothing: first-party does not mean unblockable. In one run, uBlock Origin Lite with default lists did not stop the tracker. Consent rules stay the same: no event is sent without consent, and a refusal stops regular measurement, apart from the limited ping. [Details](docs/technical-overview.md#content-blockers)
- **Bots.** A short User-Agent filter stops obvious ones. Anything that claims to be a browser passes.
- **Encoded collect URLs above 8 KiB are dropped with a diagnostic.** Reduce the number of items or parameters.
- **No cross-domain identity, durable queue or backfill.** If your server is down, its events are lost; the regular tag is unaffected.
- **Each open tab keeps its own consent state** until it reloads, so a refusal in one tab does not stop a second open tab at once.
- **HTTP 2xx proves delivery only.** Google [does not report errors](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference) on the live endpoint.
- **No legal guarantee.** Choose consent behavior and disclosures that fit your site.

## Links

- [INSTALL.md](INSTALL.md): step-by-step setup, consent, verification, updates
- [Technical overview](docs/technical-overview.md): architecture, identity, consent state machine, prior art
- [Measurement Protocol notes](docs/measurement-protocol-notes.md): what the docs say against what the validator and Realtime showed
- [Cookie banners](docs/cookie-banners.md): what consent banners really send
- [Design decisions](docs/decisions.md): each decision with its alternative and source

For development on Node 26: `npm ci && npm test && npm run typecheck && npm run build`. `npx playwright install chromium webkit && npm run test:e2e` runs the consent flow in real browsers. `tests/fuzz.test.ts` runs random sequences against rules that must always hold.

Want to change something? See [CONTRIBUTING.md](CONTRIBUTING.md). Found a security issue? See [SECURITY.md](SECURITY.md).
