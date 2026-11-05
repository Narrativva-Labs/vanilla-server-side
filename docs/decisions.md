# Design decisions

Author: František Bujnovský.

## A parallel property

The existing website tag and GTM configuration belong to the existing measurement pipeline. Vanilla has its own destination, identity and sessions. A separate property is mandatory: events are not deduplicated against the original pipeline. Comparing independent properties can reveal collection differences without changing production tagging.

## Measurement Protocol

Use the documented HTTPS JSON API, with the API secret held only on the server. Device fields and consent are top-level MP fields; session ID and measured engagement belong in event parameters. Campaign details precede the measured event in the same request at session start. Geography uses the trusted proxy IP only in cookie mode with analytics consent.

The reference and use cases explicitly limit MP reporting and describe attribution alongside tagged online events. Independent collection cannot promise browser-tag reporting parity. A successful HTTP response is transport evidence only. Never use the undocumented browser /g/collect transport: emulating it would add fragile assumptions rather than a stable public contract.

References checked against the [MP reference](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference), [campaign event](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference/events#campaign_details) and [use cases](https://developers.google.com/analytics/devguides/collection/protocol/ga4/use-cases).

## Validation and retries

Before transport, final MP event parameters are checked against the [current reference](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference) and [sending limits](https://developers.google.com/analytics/devguides/collection/protocol/ga4/sending-events#limitations): 25 parameters including automatic fields, 40-character names and 100-character string values for standard properties. Automatic parameters take precedence when space runs out. Page location, referrer and title are truncated; invalid custom fields are dropped with diagnostics containing no visitor values. Reserved event names are rejected. The final visible-time event uses the custom name page_engagement.

The reference calls device.model optional, but strict validation in deployment rejected a device object without it. The browser therefore derives a best available model from its user agent, with a generic device label when no model is exposed. The raw user agent is not transmitted.

Google's [transport guidance](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference#transport) says not to retry the same request after a non-2xx response. Vanilla deliberately makes a narrow availability tradeoff: bounded page-memory retries only for network errors, timeouts, HTTP 429 and HTTP 5xx. Other HTTP 4xx are terminal and require correcting the request; there are no retries after successful HTTP delivery. Exit engagement is best-effort and never retried. A timeout or server failure may occur after Google accepted data, so a retry can duplicate events. Local request deduplication cannot prove Google's processing state and is not exactly-once delivery. A new session is only confirmed in a cookie after successful delivery so campaign_details remains present on retry.

A same-origin reverse proxy can serve /kx7qpa/s.js and strip /kx7qpa/ before forwarding: the tracker resolves e and p relative to its script URL, SITE_ORIGIN must match the website Origin, and COOKIE_DOMAIN must cover the website host.

## Server-set cookies

The server creates a random GA-format client ID and a 30-minute inactivity session only after analytics consent. A signed HttpOnly cookie carries the state without a database; Secure and SameSite=Lax constrain transport. Invalid signatures start fresh. After withdrawal, a bounded process-local revocation map retains identity keys for 60 seconds (longer than the Google timeout); delayed collection responses cannot reissue those cookies. A transient browser identity also covers the first-request race before the server cookie arrives. This guard is not durable across a process restart. A shared first-party domain is required for sibling tracker and website hosts. COOKIE_DOMAIN is explicit when that differs from the website hostname. Signing prevents modification but provides no confidentiality or replay protection. Stateless cookies have concurrent-tab races; a database and locking would conflict with the intended small deployment.

Safari may cap this server-set identity cookie to seven days when it detects third-party CNAME or IP-address cloaking. For IPv4 this applies when the tracker and the website do not share the same /16 prefix; for IPv6, the same /64. A same-origin endpoint or matching IP prefix may avoid this particular cap, but does not guarantee that the cookie will persist for its requested 400-day lifetime. See [WebKit tracking prevention](https://webkit.org/tracking-prevention/).

The server refreshes the cookie after each successfully delivered, non-deduplicated collection request unless the identity has been revoked, so regular returning visitors renew its expiry, subject to browser limits.

## Deliberate omissions

No Ads integrations, cross-domain identity, durable retries, custom destination framework, browser fingerprinting, account service or general tag platform. Ecommerce stays close to the existing dataLayer event model. The cookieless mode uses only memory, sanitizes URLs and honors explicit analytics denial. Consent interpretation stays conservative, with direct Google consent taking precedence over supported banner fallbacks. Operational limits and in-memory deduplication are bounded and process-local.
