# Install Vanilla Server-Side

By František Bujnovský. You need a domain, access to its DNS settings and a Google Analytics account. The software is free; you pay your chosen server provider. For scale: Hetzner lists [cloud servers](https://www.hetzner.com/cloud/) from € 5.99 a month without VAT, read on 2026-11-06. The install script took about 100 seconds on a clean test machine in CI, without DNS waiting. How long a first setup takes a beginner: Not verified. Each website operator runs their own server.

Want to see it working first? `npm ci && npm run demo` runs everything locally with no account. See the [README](README.md#try-it-first). For how it works, see the [technical overview](docs/technical-overview.md).

## 1. Create a separate Google Analytics property

Leave the existing Google Analytics tag and GTM container unchanged.

In Google Analytics, open Admin -> Create -> Property. Name the new property so you can distinguish it, choose its timezone and create a Web data stream for your website. Copy its Measurement ID (G-...). **This must be a second property, never the one used by your normal Google tag.** You can compare their reports later. Do not install another Google tag for the second property.

Under Admin -> Data streams -> your new web stream -> Measurement Protocol API secrets, acknowledge any terms, choose Create and copy the secret value. Keep it private; it must never go into website code.

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
4. Measurement Protocol API secret.

The tracker waits for analytics permission: without it no event is sent and no cookie is set. A page that stays denied sends one limited ping, described in the [README](README.md#consent). To turn it off, set `DENIED_PINGS=off` in .env and rebuild as described below. Choose and disclose the appropriate behavior for your site.

To send through Google's [EU collection endpoint](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference), set `GA4_REGION=eu` in .env after installation and rebuild as described below. Leave it empty for the default endpoint.

The tracker sends page views, final engagement time and the events named in `TRACKED_EVENTS`. Without that setting it uses the list in [.env.example](.env.example): common ecommerce events plus `generate_lead`, `sign_up`, `login` and `search`. To change it, set `TRACKED_EVENTS` in .env to a comma-separated list, which replaces the default, and rebuild as described below. Other events are ignored. `page_view` is automatic and must not be listed.

Vanilla reads events straight from `dataLayer`, not from your GTM tags. An event must already carry its final GA4 name and parameters there: if the site pushes `order_complete` and a GTM tag renames it to `purchase`, the regular property gets a purchase and Vanilla gets nothing. A working example:

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

The installation is tested on a clean Ubuntu in CI; the certificate and public DNS are not verified there.

The installer sets COOKIE_DOMAIN to the hostname of SITE_ORIGIN with a leading www removed. The tracker must be that domain or any subdomain of it. For https://www.example.co.uk, both example.co.uk and kx7qpa.eu.example.co.uk work; the cookie domain stays example.co.uk. For https://eu.example.com, use kx7qpa.eu.example.com (a tracker at kx7qpa.example.com is outside the derived cookie domain). An incompatible domain stops installation with advice. The installer preserves this configuration when rerun.

## 6. Add the script once

Copy the script tag printed by the installer into your website's head or your CMS's global header field:

```html
<script defer src="https://kx7qpa.example.com/s.js"></script>
```

Replace the example domain. If the site has a Content Security Policy, allow your tracker origin in script-src and connect-src. Keep your existing GTM and regular analytics tag unchanged.

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

Decisions merge per purpose. A banner that has decided beats any Google `default`, including a regional one. A Google `update` beats what the banner reports when it is first read at load. After that the newest decision wins: a later change in the banner replaces an older `update`, and a later `update` replaces the banner's choice. An undecided banner changes nothing. Without a supported banner, a regional default stays unresolved until a direct update. GTM's internal consent API alone is not readable by this tracker. Pending events wait in RAM for at most two seconds.

After denial the tracker requests deletion of its cookie and clears pending analytics. The normal tag has its own consent handling.

## 7. Verify

Open https://kx7qpa.example.com/health. It should show ok, Google delivery counters and `botsFiltered`. With no consent signal at all, counters should not increase and no vanilla_session cookie should be set. With consent denied, which is the usual banner default, one limited ping per page raises `sent` after 2 seconds, and still no vanilla_session cookie is set. Accept analytics, navigate pages and send a test ecommerce event if available. Inspect the HttpOnly cookie in browser developer tools under Storage/Application; JavaScript cannot read it. Withdraw consent and verify deletion.

In the **second property**, open Reports -> Realtime. Then use DebugView with a temporary event carrying debug_mode:

```js
dataLayer.push({ event: "generate_lead", debug_mode: true });
```

Send that only after the required consent, remove debug flags after testing, and check development/internal traffic filters if events are missing. Use an ordinary browser for this test: headless browsers and tools such as Lighthouse identify themselves in their User-Agent and are filtered as bots. campaign_details itself does not appear in DebugView. Ordinary reports take longer than Realtime and MP reporting is partial. A successful /health delivery counter proves only Google's HTTP acceptance.

## Optional: import conversions into Google Ads

This needs a Google Ads account and an ad click with both `ad_storage` and `ad_user_data` granted, so your banner must send them. A conversion credited to a real ad click: Not verified yet.

1. In the **second property**, open Admin -> Events and mark the event you want as a key event.
2. In Google Ads, keep auto-tagging on, so that clicks carry `gclid`.
3. In the **second property**, open Admin -> Product links -> Google Ads links and link your Ads account. Do not link the regular property for this.
4. After the event has been collected, import it in Google Ads under Goals -> Conversions -> New conversion action -> Import -> Google Analytics.
5. If the regular property already imports the same conversion, set this one as secondary, or it counts twice.

Update your privacy text first: Google's role differs between Analytics and Ads, as Google's [list of services](https://business.safety.google/adsservices/) shows.

## What to disclose

Use this as a factual base for your privacy text, not as legal advice.

- **With analytics consent:** your server stores the `vanilla_session` cookie and receives the events. Google receives them with the visitor's IP address and `User-Agent`.
- **With ad consent too:** Google also receives `gclid`, `gbraid` or `wbraid` from the landing page.
- **Without consent:** after 2 seconds your server receives one request per page, with the visitor's IP address and `User-Agent`. Google receives one ping with a one-off ID, the cleaned URL, referrer, title, language, screen size and `User-Agent`. Google does not get the visitor's IP address from this ping. No cookie is set.
- **IP address on your server:** the collector keeps it in memory for the rate limit, removes it within two minutes and does not log it. The default Caddy setup has no access log. With your own proxy, check its logs and how long it keeps them.
- **What cleaning does not do:** it removes credentials, fragments and query parameters other than `utm_*`. It does not touch URL paths, UTM values or page titles, so check that yours hold no personal data, for example an email in a path. Avoid calling the ping anonymous in your privacy text unless you checked this.

## If something fails

- Installer says DNS mismatch: check the A record, public IPv4 and DNS propagation; remove stale AAAA and disable DNS proxying.
- HTTPS is not ready: check ports 80/443 in both server and provider firewalls, DNS and competing web servers. Run sudo docker compose logs --tail=50 caddy.
- No events: check the script loads, consent callback, exact SITE_ORIGIN (including www), browser network /e requests and the second property's ID/secret. If `botsFiltered` rises on /health, the test client identifies itself as automated.
- Console warning "No resolved analytics consent": the tracker found neither a Google consent command nor a supported banner. It stays silent while a supported banner is waiting for the visitor.
- Cookie absent after grant: check both hosts are HTTPS and COOKIE_DOMAIN covers both; use sibling hosts under your own domain.
- HTTP 429: the collector limits each IP to 300 requests/minute and 10 simultaneous deliveries, with 100 simultaneous deliveries globally. Check for repeated script installs or an event loop.
- Google errors: run sudo docker compose logs --tail=50 tracker. Check outbound HTTPS, ID and secret. Logs omit visitor details. On a machine with Node 22.12 or 24, in a copy of this repository, set GA4_MEASUREMENT_ID and GA4_API_SECRET in the environment or in .env, then run `npm ci` and `npm run verify:mp`. It checks the payloads against Google's validation server, on the EU endpoint when `GA4_REGION=eu` is set.
- Docker package conflict on an existing machine: follow the official Docker instructions for [Ubuntu](https://docs.docker.com/engine/install/ubuntu/) or [Debian](https://docs.docker.com/engine/install/debian/) before rerunning; use a fresh VPS if unsure.

## Updates and maintenance

From the repository folder run:

```sh
./update.sh
```

It requires a clean tracked checkout on a branch, backs up .env privately, pulls only a fast-forward update, refreshes the Caddy and Node base images, rebuilds the tracker and waits for healthy containers. Git runs as the checkout owner; only Docker and the handling of .env, which the installer creates as root, are elevated when required. Verify the public /health endpoint and Realtime afterward. Keep a secure off-server backup of .env and your domain/provider access. Backups contain secrets; never attach them to support messages. Rotate the API secret in Google Analytics and .env if exposed. Changing COOKIE_SECRET invalidates existing visitor cookies.

Before updating, record `git rev-parse HEAD`. To roll back, run `git checkout` with that revision, restore the matching private .env backup if its format changed, then run `sudo docker compose build --pull tracker && sudo docker compose up -d --wait --wait-timeout 180`. That leaves the checkout off its branch, and `./update.sh` stops until you run `git switch main`. Never roll back by deleting Caddy volumes.

Install Ubuntu security updates regularly and reboot when required. Docker and Caddy restart automatically. Logs rotate to three 10 MB files per service. Application logs omit visitor values, but Caddy may include client and request metadata in error logs when proxying fails. Restrict server access, set a retention policy appropriate for your disclosure, and check disk space with df -h.

If the VPS goes down, the original GTM measurement continues. Vanilla events during downtime can be lost: there is no durable queue or backfill. Restart the VPS or run sudo docker compose up -d; if replacing the server, clone again, restore .env, update DNS and rerun ./install.sh. Do not delete Caddy volumes during routine updates; they hold certificates.

The project does not provide a hosted service or legal compliance guarantee. Document what you collect, including IP forwarding for geography after consent, and select consent rules appropriate to your site.
