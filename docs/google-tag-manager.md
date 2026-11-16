# Amanda Tracker in Google Tag Manager

The Amanda Tracker template installs the tracker's tag, `a.js`, through Google Tag Manager. It is a
loader and a consent bridge, never a second tracker: it loads the same `a.js` as the install
snippet, and everything but the Site ID comes from your site's own config in the Amanda portal.

## Install

1. In your container, open **Templates**, then **Search Gallery** under *Tag Templates*, and add
   **Amanda Tracker**.
2. Create a tag of the **Amanda Tracker** type:
   - **Site ID:** your site's public ID, as the Amanda portal shows it.
   - **Event type:** *Initialization* (the default).
3. Fire it on the **Initialization - All Pages** trigger.
4. Preview the container, and check that `a.js?site=<your Site ID>` loads on your pages.
5. Publish.

The Initialization tag sends the pageviews, including each route change of a single-page app, and
follows the visitor's consent. Don't fire it on a consent-gated trigger: the tag decides itself what
it may send in each consent state, and while consent is declined it sends anonymous pings only, with
no cookies. Gating the tag would turn those pings off, and your consent coverage with them.

## Consent

With the consent bridge on (the default, under *Advanced settings*), the tag follows Google Tag
Manager's consent state, as your consent manager or Consent Mode sets it:

| GTM consent type                 | The tag's category |
| -------------------------------- | ------------------ |
| `analytics_storage`              | analytics          |
| `ad_storage` and `ad_user_data`  | ads: denied when either is, granted only when both are |

Each type set to denied is forwarded at once, and each change GTM reports after that. A type GTM has
no state for is never taken as a grant. Untick the bridge when your site calls `amanda('consent', ...)`
itself.

## Custom events and purchases

Add a second Amanda Tracker tag for each, beside the Initialization tag:

- **Custom event:** an event name, such as `signup`, and up to 25 properties, each a Data Layer
  Variable whose value is a string of at most 200 characters, a number or a boolean. A property whose
  variable is undefined is left out.
- **Purchase:** the order ID, revenue (in the currency's major unit, such as `249.90`), ISO 4217
  currency, and optionally the items. With GA4's e-commerce dataLayer, pick
  `ecommerce.transaction_id`, `ecommerce.value`, `ecommerce.currency` and `ecommerce.items`: GA4's
  `item_id`, `item_name`, `quantity` and `price` are read as the tag's own item fields. A reloaded
  confirmation page sends the same order again harmlessly: purchases are deduplicated by order ID.

Fire them on your own triggers, such as a custom event for `signup` or GA4's `purchase`. Each loads
`a.js` too, if the Initialization tag hasn't, and the calls wait until it has loaded.

## Sending through your own site

To send through a first-party reverse proxy on your own site, set **Endpoint override** (under
*Advanced settings*) to its path, such as `/amnda`. See [First-party reverse proxy](first-party-proxy.md).

## Permissions

The template asks Google Tag Manager for these permissions, and nothing beyond them:

| Permission         | What for                                                                   |
| ------------------ | -------------------------------------------------------------------------- |
| Injects scripts    | `https://eu.serversider.com/a.js*` only: the tag itself                    |
| Accesses globals   | `amanda` and `amanda.q` only: the tag's command function and its queue     |
| Accesses consent   | reads `analytics_storage`, `ad_storage` and `ad_user_data`; writes none    |
| Logs to console    | in debug mode (Preview) only                                               |

It reads no cookies and no dataLayer keys itself, and sends nothing itself: `a.js` does, as the
install snippet's would. To check what `a.js` is, see [Verifying a release](verifying-a-release.md).

## Troubleshooting

In Preview, the template logs to the console when it fails:

- `Amanda Tracker: a.js failed to load from <url>`: a content blocker, your site's
  Content Security Policy (allow `https://eu.serversider.com` in `script-src` and `connect-src`), or
  a network failure.
- `Amanda Tracker: Revenue is not a number` or `Items is not an array`: a purchase tag's variable
  doesn't hold what the field needs. The purchase is not sent.

The template's source and its tests are in
[amandatracker-tag](https://github.com/Amanda-AI-AB/amandatracker-tag) (`template.tpl`), under the
Apache-2.0 licence.
