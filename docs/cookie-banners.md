# Cookie banners: what they really send

What consent banners really put in `dataLayer`, as opposed to what integration guides suggest. This is why the tracker treats "no decision yet" as its own state.

Every finding is marked:

- **Live**: seen on production websites on 2026-11-05. Headless Chromium read `dataLayer` before a click on "accept", after it, and after a reload, with analytics and advertising requests blocked. Some runs allowed Google Tag Manager and some blocked it. The sample is small: CookieYes 7 sites, Shoptet 5, Complianz 4, Didomi 2, Borlabs, OneTrust and Usercentrics 1 each. Tested sites are not named. The refusal path was not clicked.
- **Vendor code**: read in the vendor's published source. CookieYes CDN script as served on 2026-11-05, CookieYes WordPress plugin 3.5.8, Complianz Free 7.5.7, [Shoptet templates](https://github.com/shoptet/templates-assets/blob/master/shared/js/libs/consent.js).
- **Vendor docs**: the vendor's documentation.

To repeat this on your own site, run the line below in the browser console before and after your choice:

```js
dataLayer.filter(x => x[0] === "consent").map(x => [...x])
```

## Patterns

| Pattern | Seen with | Evidence | Why it matters | How Vanilla reads it |
| --- | --- | --- | --- | --- |
| `update` with `denied` at load, before any click | CookieYes, Complianz in direct mode | Live; CookieYes also vendor code | It looks like a refusal and is not one | Collection stays off either way, the safe side. With a supported banner in its undecided state it is not treated as a refusal: no cookie deletion request. Without one, one deletion request is sent |
| `default` with `denied` for everyone | CookieYes, Shoptet, Complianz, Borlabs, Usercentrics, Didomi | Live | Default is a starting value, not a choice | Denied, with no cookie deletion request |
| `default` with `region` | CookieYes on WordPress | Live; vendor code | The script cannot know whether the visitor is in that region | Unknown until a direct update. A banner fallback cannot resolve it |
| `update` without any `default` | CookieYes CDN, OneTrust | Live | Consent appears from nothing, so a tool waiting for a default waits forever | The update is applied |
| Partial `update`, one or a few keys at a time | Borlabs; CookieYes next to the WP Consent API | Live | `analytics_storage` and the ad keys arrive in separate commands | Merged key by key |
| `default` already carrying `granted` on return visits | Shoptet, Usercentrics, Borlabs | Live | The stored decision travels in the default | Granted |
| Consent only in Google Tag Manager's internal state, no `gtag` command in `dataLayer` | Complianz in GTM mode | Live | The page's `dataLayer` shows `cmplz_event_*` events and no `Arguments` entry | Not readable, not supported. The console warning fires |
| No Google command at all | Shoptet stores where `gtag` is not defined | Live | Only the `cookie_consent` object exists | Read through the Shoptet adapter |

## By vendor

### CookieYes

- **CDN script:** `gtag` update is sent only when `dataLayer` already exists. Vendor code: the update function returns early when `window.dataLayer` is not an array. Live: a site with no `dataLayer` got no command; after creating one first, the commands appeared. Vanilla creates `dataLayer` if it is missing.
- **WordPress plugin without the web app connection:** no `gtag` update after the click. Vendor code: `gcm.js` sends `default`, and sends `update` only at load from an existing cookie; `script.js` contains no `gtag` call and fires `cookieyes_consent_update` on the document. Live: the same on a site with Google Tag Manager blocked.
- **`getCkyConsent()`** works in both. Live: `isUserActionCompleted` is `false` before a choice while every category reads as rejected, so only that flag separates undecided from refused. Vanilla uses it.

### Complianz

- **Premium in GTM mode:** nothing is added to `dataLayer` as `Arguments`. Live: two sites; Google Tag Manager's internal consent state changes, and the page only sees `cmplz_event_statistics` and similar events. Not supported by Vanilla.
- **Free:** consent mode is off by default. Vendor code: the `consent-mode` setting defaults to `no` and is marked as a premium option.
- **Direct mode:** Live: `default` denied, then `update` denied at load, then `update` granted on accept.

### Shoptet

- Vendor docs: [`cookie_consent` object](https://developers.shoptet.com/3rd-party-marketing-and-analytics-cookies-in-add-ons/) in `dataLayer`, default state `denied` for analytics and marketing, and an event `cookie_consent` after the visitor's choice.
- Vendor code: [`shoptet.consent`](https://github.com/shoptet/templates-assets/blob/master/shared/js/libs/consent.js) provides `get`, `set`, `isSet`, `isAccepted` and `onAccept`.
- Live: `denied` in `cookie_consent` before any choice. `isSet()` is `false` until the visitor decides, so Vanilla uses it to separate undecided from refused. Stores with `gtag` defined also send `default` and `update` commands; the others send only the object.

### Others

Live, one or two sites each, not supported by an adapter:

- **Didomi:** one site sent `default` and `update` commands, which Vanilla reads. On a second site the banner could not be clicked in the test, and no command appeared before interaction.
- **OneTrust:** `update` on accept, no `default`. Vanilla reads it.
- **Usercentrics:** `default` and `update` commands. Vanilla reads them.
- **Borlabs:** `default`, then separate updates for analytics and ads. Vanilla reads them.

Other configurations of the same products can behave differently. Check your own site with the console line above.

## The rule that follows

**An `update` to `denied` at load is not a refusal, and `denied` before any interaction is not a decision.** Only a banner's own "decided" signal, or a real later change, says the visitor chose. See the [consent state machine](technical-overview.md#consent-state-machine).
