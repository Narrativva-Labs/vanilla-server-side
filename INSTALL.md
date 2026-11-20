# Install Vanilla Server-Side

By František Bujnovský. You need a domain, access to its DNS settings and a Google Analytics account. The software is free; you pay your chosen server provider. For scale: Hetzner lists [cloud servers](https://www.hetzner.com/cloud/) from € 5.99 a month without VAT, read on 2026-11-06. The install script took about 100 seconds on a clean test machine in CI, without DNS waiting. How long a first setup takes a beginner: Not verified. Each website operator runs their own server.

Want to see it working first? With Node 22.12+ within 22.x, 24.x, or 26+, `npm ci && npm run demo` runs everything locally with no account. Docker uses Node 26. See the [README](README.md#try-it-first). For how it works, see the [technical overview](docs/technical-overview.md).

## 1. Create a separate Google Analytics property

Leave the existing Google Analytics tag and GTM container unchanged.

In Google Analytics, open Admin -> Create -> Property. Name the new property so you can distinguish it, choose its timezone and create a Web data stream for your website. Copy its Measurement ID (G-...). **This must be a second property, never the one used by your normal Google tag.** You can compare their reports later. Do not install another Google tag for the second property.


## 2. Get a small server

Choose a VPS with Ubuntu 24.04 LTS and at least 1 GB RAM. Hetzner, DigitalOcean and OVHcloud are common options; choose a location and plan appropriate to your needs. Use a fresh server, with SSH access enabled. Your provider shows its public IPv4 address and login instructions in its control panel.

Allow inbound TCP ports 80 and 443 for HTTPS setup and requests, and port 22 for SSH in the provider firewall. Do not open port 3000. Avoid installing other web servers on ports 80/443.

## 3. Connect over SSH

On Mac, open Terminal (Applications -> Utilities). On Windows, open PowerShell or Windows Terminal. Replace SERVER_ADDRESS with the address shown by your provider:

```sh
ssh root@SERVER_ADDRESS
```

Some providers supply an ubuntu user instead of root: use their instructions. Check the first connection's host fingerprint against the provider console before accepting it. Enter the password or use the SSH key selected during server creation. Password entry may show no characters. Once connected, commands run on the VPS, not on your own computer.

## 4. Point DNS to the server

Choose a subdomain for the tracker. This guide uses kx7qpa.example.com as a placeholder; any name works. A neutral random name lowers the chance of a filter list match but guarantees nothing, and first-party does not mean unblockable ([details](docs/technical-overview.md#content-blockers)).

In your domain provider's DNS panel add an **A** record named kx7qpa, pointing to the VPS IPv4 address. For a website at www.example.com this gives kx7qpa.example.com. Use DNS-only mode, without a CDN proxy, for this setup. Remove conflicting A/AAAA records for that subdomain.

The tracker and website should share the same parent domain. Do not use a provider-owned server hostname. On your computer, check propagation:

```sh
nslookup kx7qpa.example.com
```

The result must show your VPS address. DNS changes can take time. The installer checks the A record against the server's public IPv4 address; if detection fails, check your provider panel and networking, then rerun.

## 5. Install

No release is tagged yet: installation and `./update.sh` follow the default branch.
Record `git rev-parse HEAD` before deployment and updates; rollback instructions are
[below](#updates-and-maintenance). There are no maintained release branches.


In your SSH session:

```sh
sudo apt-get update
sudo apt-get install -y git
git clone https://github.com/Narrativva-Labs/vanilla-server-side.git
cd vanilla-server-side
./install.sh
```

The installer uses root or sudo. It supports Ubuntu and Debian, installs Docker Engine and Compose from [Docker's official package repository](https://docs.docker.com/engine/install/ubuntu/). It then asks for:

1. Tracker domain, without https:// (kx7qpa.example.com).
2. Website origin, with https:// and no path (https://www.example.com).
3. Measurement ID from the second property.

The tracker waits for analytics permission for full events and cookies. With denied consent or a readable undecided banner it sends cookieless event pings, described in the [README](README.md#consent). To turn it off, set `DENIED_PINGS=off` in .env and rebuild as described below. Choose and disclose the appropriate behavior for your site.

To send through Google's [EU collection endpoint](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference), set `GA4_REGION=eu` in .env after installation and rebuild as described below. Leave it empty for the default endpoint.

The tracker sends page views, final engagement time and the events named in `TRACKED_EVENTS`. Without that setting it uses the list in [.env.example](.env.example): common ecommerce events plus `generate_lead`, `sign_up`, `login` and `search`. To change it, set `TRACKED_EVENTS` in .env to a comma-separated list, which replaces the default, and rebuild as described below. Other events are ignored. `page_view` is automatic and must not be listed.

Vanilla reads events straight from `dataLayer`, not from your GTM tags. It also reads `gtag("event", …)` commands, except those with `send_to`, which are meant for one destination (plugins for Google Ads or Merchant Center send their own `page_view` and `view_item` this way). An event must already carry its final GA4 name and parameters there: if the site pushes `order_complete` and a GTM tag renames it to `purchase`, the regular property gets a purchase and Vanilla gets nothing. A working example:

```js
dataLayer.push({
  event: "purchase",
  ecommerce: {
    transaction_id: "1001",
    value: 1250,
    currency: "CZK",
    items: [{ item_id: "sku-1", item_name: "Book", price: 1250, quantity: 1 }],
  },
});
```

The installer generates a signing secret, writes .env with owner-only permissions, checks DNS, starts the services and waits up to three minutes for HTTPS, including health request timeouts. Caddy obtains and renews certificates. Rerunning preserves .env. For manual changes, run sudo nano .env then sudo docker compose up -d --build. Never share or commit .env.

The installation is tested on a clean Ubuntu in CI, on x86 and ARM servers: first install, a second run that keeps .env, and an update. The certificate and public DNS are not verified there. The live test sites use nginx, not the default Caddy setup. A real Let's Encrypt certificate obtained through this installer has not been tested; see [verification limits](docs/verification.md). On 2026-11-17 a minimal Ubuntu 24.04 on ARM, without git or Docker, went through the steps above in a local container up to `docker compose up`; the build then failed on the container's nested file system, so that run is not a completed installation.

The installer sets COOKIE_DOMAIN to the hostname of SITE_ORIGIN with a leading www removed. The tracker must be that domain or any subdomain of it. For https://www.example.co.uk, both example.co.uk and kx7qpa.eu.example.co.uk work; the cookie domain stays example.co.uk. For https://eu.example.com, use kx7qpa.eu.example.com (a tracker at kx7qpa.example.com is outside the derived cookie domain). An incompatible domain stops installation with advice. The installer preserves this configuration when rerun.

## 6. Add the script once

Copy the script tag printed by the installer into your website's head or your CMS's global header field:

```html
<script async src="https://kx7qpa.example.com/s.js"></script>
```

Replace the example domain. Keep `async`: with `defer`, a tracker server that was switched off held `DOMContentLoaded` and the cookie banner for 75 seconds (Chromium on macOS, measured 2026-11-10), because the browser waited for the connection to time out; with `async` the page did not wait at all. If the site has a Content Security Policy, allow your tracker origin in script-src and connect-src. Keep your existing GTM and regular analytics tag unchanged.

### WordPress

Theme files are replaced by updates, so use a header code plugin instead, for example [WPCode](https://wordpress.org/plugins/insert-headers-and-footers/), and paste the tag into its header box.

### Check your purchase event

Place a test order. On the thank-you page, open the browser console and run:

```js
dataLayer.filter((item) => item.event === "purchase");
```

You should see one item with `transaction_id`, `value`, `currency` and `items`, directly or inside `ecommerce`. If it is missing or has another name, Vanilla will not measure it, even when the regular property shows the order. That needs a change on the site or in its plugin, not in Vanilla.

## Connect your consent banner

The tracker sends no event until analytics_storage is granted. Use your banner's actual choice; do not grant consent merely because the tracker has loaded.

Cookiebot, CookieConsent by Orest Bida, CookieYes and the Shoptet cookie bar are read automatically. Complianz in GTM mode and other banners installed through a GTM template are not supported. A Shoptet store with the cookie bar turned off stays undecided, so nothing is sent there. For CookieConsent custom categories, add data-cc-analytics-category="stats" and optionally data-cc-ads-categories="ads,marketing" to the script tag.

If your banner already issues direct Google consent commands into dataLayer, Vanilla reads them too. Otherwise connect its callback to a command like this, using the actual choice:

```js
window.dataLayer = window.dataLayer || [];
function gtag() { dataLayer.push(arguments); }
// Example after the visitor accepts analytics but declines advertising:
gtag("consent", "update", {
  analytics_storage: "granted",
  ad_storage: "denied",
  ad_user_data: "denied",
  ad_personalization: "denied"
});
// On withdrawal send analytics_storage: "denied" plus the actual ad choices.
```

Decisions merge per purpose. A banner that has decided beats any Google `default`, including a regional one. A Google `update` beats what the banner reports when it is first read at load. After that the newest decision wins: a later change in the banner replaces an older `update`, and a later `update` replaces the banner's choice. An undecided banner changes nothing. Without a supported banner, a regional default stays unresolved until a direct update. GTM's internal consent API alone is not readable by this tracker. Events pushed before the visitor decides wait in RAM, at most 50 per page and up to 30 seconds each, and go out only after a grant; an event older than 30 seconds, a refusal or leaving the page discards them.

After denial the tracker requests deletion of its cookie and clears pending analytics. The normal tag has its own consent handling.

## 7. Verify

Open https://kx7qpa.example.com/health. It should show ok, Google delivery counters and `botsFiltered`. With no consent signal at all, counters should not increase and no vanilla_session cookie should be set. With consent denied or a readable undecided banner, the automatic page view and each allowed event raise `sent` via cookieless pings, and no vanilla_session cookie is set. A readable banner sends immediately; a Google default alone waits its `wait_for_update` (0 when omitted, at most 2 seconds). Accept analytics, navigate pages and send a test ecommerce event if available. Inspect the HttpOnly cookie in browser developer tools under Storage/Application; JavaScript cannot read it. Withdraw consent and verify deletion.

In the **second property**, open Reports -> Realtime. Then use DebugView with a temporary event carrying debug_mode:

```js
dataLayer.push({ event: "generate_lead", debug_mode: true });
```

Send that only after the required consent, remove debug flags after testing, and check development/internal traffic filters if events are missing. Use an ordinary browser for this test: headless browsers and tools such as Lighthouse identify themselves in their User-Agent and are filtered as bots. campaign_details itself does not appear in DebugView. Ordinary reports take longer than Realtime and reports can differ from the regular tag. A successful /health delivery counter proves only Google's HTTP acceptance.

## Optional: import conversions into Google Ads

This needs a Google Ads account and an ad click with both `ad_storage` and `ad_user_data` granted, so your banner must send them. A conversion credited to a real ad click: Not verified yet.

1. In the **second property**, open Admin -> Events and mark an approved purchase event as a key event. Do not import lead events from this property.
2. In Google Ads, keep auto-tagging on, so that clicks carry `gclid`.
3. In the **second property**, open Admin -> Product links -> Google Ads links and link your Ads account. Do not link the regular property for this.
4. After the event has been collected, import it in Google Ads under Goals -> Conversions -> New conversion action -> Import -> Google Analytics.
5. If the regular property already imports the same conversion, set this one as secondary, or it counts twice.

Update your privacy text first: Google's role differs between Analytics and Ads, as Google's [list of services](https://business.safety.google/adsservices/) shows.


Do not import leads from the second property into Google Ads: importing key events
also imports leads from agents and automation. Send qualified leads from the backend/CRM
using [offline conversion import](https://support.google.com/google-ads/answer/2998031)
or [enhanced conversions for leads](https://support.google.com/google-ads/answer/11021502).
GA4's UI rules are calculated client-side and do not apply to Vanilla's server-to-server
hits ([GA4 limits](https://support.google.com/analytics/answer/10085872)). Settled purchases
remain eligible under the [conversion guidance](https://github.com/Narrativva-Labs/visitor-verdict/blob/main/docs/conversion-guidance.md);
backend payment/fraud checks still apply.

## What to disclose

Use this as a factual base for your privacy text, not as legal advice.

- **With analytics consent:** your server stores the `vanilla_session` cookie and receives the events. Google receives them with the visitor's IP address and `User-Agent`.
- **With ad consent too:** Google also receives `gclid`, `gbraid` or `wbraid` from the landing page.
- **Without consent:** the automatic page view and each allowed event send a cookieless ping. A readable banner, including an undecided one, sends immediately; a Google denied default alone waits only `wait_for_update` (0 when omitted, capped at 2 seconds). With no signal nothing is sent. Google receives the full visitor IP (`_uip`), `User-Agent`, sanitized event parameters including items, value and currency, cleaned URL, referrer, title, language and screen size. Page identity lasts only for the page; session_id is the page-load second and can collide across visitors. Group pings by batch_page_id, never ga_session_id. No cookie, click ID or `user_data` is sent. Pings never retry; `page_engagement` is excluded. Disclose IP and event parameters in your privacy notice. Tests: `tests/denied-events.test.ts`.
- **Optional labels on pings and full events:** browser traffic_class/traffic_phase and server agent_verification/agent_operator/agent_purpose/agent_claim describe traffic and operator evidence. The browser detector uses minimal sessionStorage. Disclose these fields and distinguish them from a visitor identity.
- **IP address on your server:** the collector keeps it in memory for the rate limit, removes it within two minutes and does not log it. The default Caddy setup has no access log. With your own proxy, check its logs and how long it keeps them.
- **What cleaning does not do:** it removes credentials, fragments and query parameters other than `utm_*`. It does not touch URL paths, UTM values or page titles, so check that yours hold no personal data, for example an email in a path. Avoid calling the ping anonymous in your privacy text unless you checked this.

## If something fails

- Installer says DNS mismatch: check the A record, public IPv4 and DNS propagation; remove stale AAAA and disable DNS proxying.
- HTTPS is not ready: check ports 80/443 in both server and provider firewalls, DNS and competing web servers. Run sudo docker compose logs --tail=50 caddy.
- No events: check the script loads, consent callback, exact SITE_ORIGIN (including www), browser network /e requests and the second property's Measurement ID. If `botsFiltered` rises on /health, the test client identifies itself as automated.
- Console warning "No resolved analytics consent": the tracker found neither a Google consent command nor a supported banner. It stays silent while a supported banner is waiting for the visitor.
- Cookie absent after grant: check both hosts are HTTPS and COOKIE_DOMAIN covers both; use sibling hosts under your own domain.
- HTTP 429: the collector limits each IP to 1,200 requests/minute and 100 simultaneous deliveries, with 300 simultaneous deliveries globally. Check for repeated script installs or an event loop. Ordinary events are sent one at a time and retried up to three times; cookieless event pings and final engagement time are never retried. Several event pings can be in flight at once. Measured on the live server on 2026-11-08 with real Chromium: 10 visitors at once behind one address, 0 refusals; with the earlier limit of 10, 5 visitors at once lost 4 of 14 pings to 429. With 30 simultaneous deliveries per IP, 28 visitors at once lost the ends of their funnels (2026-11-10), so the limit was raised on 2026-11-12.
- Google errors: run sudo docker compose logs --tail=50 tracker. Check outbound HTTPS and the Measurement ID. Logs omit visitor details. Google refuses more than 16 KiB of event data (about 130 items); the log then says how many items were left out of the purchase. To follow single events, set `LOG_EVENTS=on` in .env and rebuild: each event writes one line with its name, the HTTP answer and the outcome at Google (`sent`, `retry`, `dropped`, `duplicate`, `bot`, `withdrawn`), and nothing about the visitor. Turn it off again when done. HTTP acceptance does not prove processing: verify the event and session source in the second property.
- Docker package conflict on an existing machine: follow the official Docker instructions for [Ubuntu](https://docs.docker.com/engine/install/ubuntu/) or [Debian](https://docs.docker.com/engine/install/debian/) before rerunning; use a fresh VPS if unsure.

## Updates and maintenance

From the repository folder run:

```sh
./update.sh
```

It requires a clean tracked checkout on a branch, backs up .env privately, pulls only a fast-forward update, refreshes the Caddy and Node base images, rebuilds the tracker and waits for healthy containers. Git runs as the checkout owner; only Docker and the handling of .env, which the installer creates as root, are elevated when required. Verify the public /health endpoint and Realtime afterward. Keep a secure off-server backup of .env and your domain/provider access. Backups contain secrets; never attach them to support messages. Changing COOKIE_SECRET invalidates existing visitor cookies.

Before updating, record `git rev-parse HEAD`. To roll back, run `git checkout` with that revision, restore the matching private .env backup if its format changed, then run `sudo docker compose build --pull tracker && sudo docker compose up -d --wait --wait-timeout 180`. That leaves the checkout off its branch, and `./update.sh` stops until you run `git switch main`. Never roll back by deleting Caddy volumes.

Install Ubuntu security updates regularly and reboot when required. Docker and Caddy restart automatically. Logs rotate to three 10 MB files per service. Application logs omit visitor values, but Caddy may include client and request metadata in error logs when proxying fails. Restrict server access, set a retention policy appropriate for your disclosure, and check disk space with df -h.

If the VPS goes down, the original GTM measurement continues. Vanilla events during downtime can be lost: there is no durable queue or backfill. Restart the VPS or run sudo docker compose up -d; if replacing the server, clone again, restore .env, update DNS and rerun ./install.sh. Do not delete Caddy volumes during routine updates; they hold certificates.

The project does not provide a hosted service or legal compliance guarantee. Document what you collect, including IP forwarding for geography after consent, and select consent rules appropriate to your site.

## AI agent verification (optional)

With `AGENT_VERIFICATION=on`, /e and /d label verified operator evidence from
Visitor Verdict. The default is off. This labels traffic; it does not itself
withhold anything or change consent. **unverified ≠ human**.

Only JavaScript-executing visitors that pass the obvious-bot filter reach verification.
UAs matching `bot`/`crawl`/`spider` or `HeadlessChrome` are dropped first, including the
full ChatGPT-User UA containing `openai.com/bot`. Most crawler registry entries therefore
never reach GA4 in the default setup. Registry entries are capabilities, not observed coverage.
Live signature capture has been confirmed only for the ChatGPT agent (OpenAI);
other signing configurations have no captured live request here. See the
[measured sample and limits](README.md#ai-agent-verification-optional).

### Operator capabilities

Capabilities below describe the bundled 0.3.1 registry, before
Vanilla's filter and cache requirements. Reverse DNS is off in Vanilla.
A published IP match is network evidence, not cryptographic request authentication.

| Evidence available | Operators / routes | Local live signature capture |
|---|---|---|
| HTTP signature | OpenAI ChatGPT cloud browser | Yes, one header-capture run (32 requests) |
| HTTP signature configuration, not captured here | Google hosted agent, DuckDuckGo, Browserbase, Manus; some identities are provisional | No |
| Published IP/SAIL feeds | OpenAI fetchers/crawlers; Google mapped agent/fetcher/crawler tokens; Anthropic (Claude-Agent uses SAIL); Perplexity; DuckAssistBot; Apple; Microsoft; Mistral User/Index; Kimi; Common Crawl; Seznam; Naver | No additional signature captures |
| Configured static IPs | Kagi | No |
| rDNS only, inactive here | Baidu, Petal, Yandex, Amazon Ads | No |
| Claim only | Amazon crawler family, You.com, Sogou, ByteDance, DeepSeek, Zhipu, Shenma, 360, Diffbot, Timpi; Mistral Training | No |

A recognized UA or an accessible key directory alone verifies no request. Signature
verification needs a valid covered request and usable cached key; IP evidence needs
a matching token and trusted source IP. [Server documentation](https://github.com/Narrativva-Labs/visitor-verdict/tree/phase2-verifier/server#operator-coverage-and-sources-checked-2026-11-20)
tracks the detailed sources and limits.

`TRACKER_DOMAIN` is the trusted external host, without a scheme/path; a port is
allowed, for example `tracker.example:8443`. Both routes use cache-only verification:
a missing, expired or unavailable cache uses the available claim/browser evidence and starts
one background refresh. There is no wait for operator I/O or later backfill.
Key directories warm once at startup and refresh in the background (about every
270 seconds for no-store). Failed refreshes retain valid cached data up to the hard
24-hour age limit, always honouring JWK validity/removal. Reverse DNS is disabled.

Startup prints `Agent verification on for <host>`. `/health` exposes
`agentVerification: { enabled, directoriesLoaded: "n/N", lastRefreshOk, counters }`.
A loaded document is not proof of an active key. Last outcome is null before any
refresh completes and otherwise describes the most recent directory/feed refresh.
Directory, IP-list and SAIL refresh failures warn at most once per failing endpoint hostname per ten minutes, with only
that hostname and a short reason code; no visitor data or request URL is logged.
For example, a failed DuckAssist key-directory refresh names assistbot.duckduckgo.com,
without its path or query. lastRefreshOk describes
the latest completed refresh of any document, not whether all feeds are healthy.

Client-supplied vv_type, vv_detail and the old agent_verification, agent_operator,
agent_purpose, agent_claim, traffic_class and traffic_phase names are reserved and
stripped from outgoing GA4 parameters. Browser class/phase remain tracker inputs to
Vanilla. Priority within 25 parameters: GA4 automatic fields; ecommerce
fields (transaction_id, value, currency, items, tax, shipping, coupon and the other
ecommerce fields); vv_type; vv_detail; other site parameters. At the 16 KiB body
limit, remove vv_detail first, then vv_type, then the last items, preserving revenue.

## Visitor Verdict browser class (optional)

Load the [Visitor Verdict detector](https://github.com/Narrativva-Labs/visitor-verdict#pinned-direct-script-build)
with a plain script tag before s.js (or self-host its pinned build). Vanilla never
loads it. It reads the frozen window.__visitorVerdict snapshot when sending a hit:
only class and phase are sent to Vanilla, on both full events and denied pings; the server
uses them in vv_type/vv_detail and does not forward the old fields to GA4. Unknown
values are dropped. The browser class works with verification off and is spoofable.
The detector uses minimal sessionStorage; disclose it before installing. Leave its
own traffic_class event out of TRACKED_EVENTS. Early hits may lack a browser class.

## Analyst value dictionary

Register exactly **vv_type** and **vv_detail** as **event-scoped custom dimensions**.
Data API names: `customEvent:vv_type` and `customEvent:vv_detail`.

| vv_type | Meaning |
|---|---|
| human | Human-looking browser, without stronger evidence; masked automation can look the same |
| pending | No browser/evidence yet, or verified operator whose product purpose is unknown |
| agent_verified | Verified signature/IP evidence with documented user_directed purpose |
| crawler_verified | Verified signature/IP evidence with documented crawler purpose |
| bot_automation | Hard browser automation evidence |
| agent_unverified | Browser declared_agent or an unverified UA/signature-agent claim |
| bot_suspicious | Soft browser evidence |
| bot_spoofed | Invalid server signature; strongest classification |

Derivation uses the first matching rule: invalid signature; verified user_directed /
crawler / unknown purpose; automated browser; declared browser or server claim;
suspicious browser; human browser; pending. Verified unknown purpose stays pending:
identity is established, but neither agent nor crawler purpose is inferred, and it is
never called unverified. A verified operator may still submit spam.

`vv_detail` is an operator-first string, at most 100 characters:
`operator|verification|purpose|claim|browser_class|browser_phase`.
Example: `openai|signature_valid|user_directed|signature_agent|human|final`.
There is no version segment. Missing segments are `-`; unknown operator is `none`.

| Segment | Values |
|---|---|
| operator | Registry operator ID (see capabilities), or none; known operator retained within session |
| verification | signature_valid, ip_match, signature_invalid, no_signature, none, or - without server evidence |
| purpose | user_directed, crawler, unknown, or - without server evidence |
| claim | signature_agent, ua_token, none, or - without server evidence; claims are untrusted |
| browser_class | human, suspicious, automated, declared_agent, or - |
| browser_phase | initial, final, or - |

Without stronger server evidence, browser classes map as follows:

| Browser input | vv_type |
|---|---|
| human | human |
| suspicious | bot_suspicious |
| automated | bot_automation |
| declared_agent | agent_unverified |
| none / missing | pending |

GTM-only sites keep traffic_class for now.

Filter GA4 by vv_type **begins with** `agent_` for agents, or `bot_` for automation,
suspicion and spoofed signatures. Include `crawler_verified` separately when needed.
Filter vv_detail **begins with** `openai|` for OpenAI evidence. In Looker Studio create
an operator dimension with `REGEXP_EXTRACT(vv_detail, '^([^|]+)')`.

Every later hit retains the strongest vv_type observed in that session. Ranks are
pending=0, human=1, bot_suspicious=2, agent_unverified=3, bot_automation=4,
crawler_verified=agent_verified=5, bot_spoofed=6; the earliest classification wins ties.
The detail describes the current hit, with the last known operator carried forward.
This is immediate memory-only state, bounded to 10,000 LRU entries with 30 minutes
of inactivity; full events use client_id + session_id, denied pings use page_id only.
No IP is retained in this state. State is cleared on server close/restart, and eviction
or expiry starts fresh. Nothing waits for later evidence and no hit is backfilled.
Missing labels after budget trimming or on historical hits are missing coverage.

User agents matching bot/crawl/spider in the existing obvious-bot filter are dropped
**before labelling and never reach GA4**. This includes many official crawler UAs and
a full ChatGPT-User UA containing the openai.com/bot URL. The bare browser claim in
the example above can pass. Missing data from that filter cannot be reconstructed
from these labels.

### Enable in five steps

1. Edit .env: set `AGENT_VERIFICATION=on` and `TRACKER_DOMAIN=tracker.example`
   (use your external host; it may include a port, without a scheme/path).
2. Rebuild: `sudo docker compose up -d --build tracker`.
3. Check startup output for `Agent verification on for <host>`.
4. Check `https://<host>/health`: enabled must be true; directoriesLoaded moves from
   0/N as warm-up finishes. lastRefreshOk=false or n<N calls for checking egress and
   the rate-limited host/reason warning. Hits are still forwarded immediately with available evidence; absent server
   evidence is not proof of humanity.
5. In GA4 **Admin → Data display → Custom definitions**, create the two event-scoped
   dimensions above. These use two of the [50 slots in a standard property](https://support.google.com/analytics/answer/14240153).

Allow outbound HTTPS for the bundled registry as needed:

**Key directories, warmed at startup:**
`assistbot.duckduckgo.com`, `chatgpt.com`, `agent.bot.goog`, `www.browserbase.com`, `api.manus.im`.

**IP-list/SAIL hosts, loaded on matching claims:** `www.kimi.ai`, `index.commoncrawl.org`, `search.seznam.cz`, `searchadvisor.naver.com`, `search.developer.apple.com`, `www.bing.com`, `mistral.ai`, `duckduckgo.com`, `openai.com`, `developers.google.com`, `claude.com`, `www.perplexity.ai`.
Many crawler claims are dropped by the bot filter before these feeds are needed.
No visitor values are appended to these URLs. Key directories load at startup;
IP/SAIL feeds load as relevant claims arrive. Startup and misses never wait for egress.


### Anonymous hit counters

Use `/health` → `agentVerification.counters` to **measure your own share of verified agents and bots**
before choosing any routing rules. `since` is the process start time in ISO UTC.
All other leaves are nonnegative integers. State is fixed-size, memory-only and resets
on restart, without a reset endpoint or persistence. Each running process has its own
totals; after a restart start a new measurement interval.

`events` counts full `/e` events; `pings` counts cookieless `/d` pings separately.
Each group contains:

- `total`: hits that reached server labelling, once per delivery attempt. This includes
  Google delivery failures; retries that reach labelling count again. Duplicate events,
  rejected requests, disabled pings and obvious bots filtered before labelling do not count.
- `byType`: one counter for each of the eight `vv_type` values, after sticky session/page
  evidence is applied. These sum to `total`.
- `byVerification`: signature_valid, ip_match, signature_invalid, no_signature, none,
  and `cache_miss/unavailable`. The last bucket covers unavailable verification (including
  verification off or an exception), cache misses and unavailable evidence with no proof.
  Valid or invalid proof keeps its verification outcome. These sum to `total`.
- `evidence.signatureHeaders`: hits carrying any Signature, Signature-Input or
  Signature-Agent header, even empty or malformed. Presence is not proof.
- `evidence.uaClaim`: hits with a known UA claim token, using the verifier's token list
  and boundaries, including with verification off.
- `evidence.browserNonHuman`: hits with a valid suspicious, automated or declared_agent
  browser class. Missing, invalid and human classes do not increment this counter.

Evidence counters overlap; do not sum them to estimate a visitor count. Divide a
`byType` or `byVerification` bucket by its group's `total` for a labelled-hit share,
keeping full events and pings separate. A visit can generate many hits, and pings and
full events may describe the same page. The denominator excludes non-JavaScript
fetchers and filtered bots, so it is not a share of all HTTP requests or all visitors.
Counters store no hosts, IPs, UAs, identifiers, signatures, URLs or per-hit records.
Only the timestamp and aggregate integers are exposed under `counters`.

Since verifier 0.3.1, refresh callbacks carry the public endpoint hostname (no URL), and
`serverAgentTokens` exposes the claim-token list, so presence counting uses the same tokens
as verification.
