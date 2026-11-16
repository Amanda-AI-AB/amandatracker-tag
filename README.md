# amandatracker-tag

The Amanda Tracker website tag, `a.js`: one script, first-party cookies only, consent-native.
Licensed under Apache-2.0.

## Status

The tag boots, but sends no events yet. `a.js` (`src/core/boot.ts`) reads its script tag's `data-site`
and `data-endpoint` (or, when the tag has no such attribute, the `site` and `endpoint` parameters of
its `src` query, `a.js?site=<SITE_PUBLIC_ID>&endpoint=<url>`, which is how the Google Tag Manager
template installs it, since GTM's `injectScript` sets no attributes), fetches the site's config from `cfg/<SITE_PUBLIC_ID>.json` without cookies,
replaces the snippet's `window.amanda` stub with the real command function and runs the calls it
queued, then makes a pageview on load and on each route change of a single-page app
(`history.pushState`, `history.replaceState` and `popstate`; a fragment-only change is not a new
page). Every step runs inside an error boundary (`src/core/boundary.ts`): a failure never reaches the
host page. It is reported instead (`src/core/telemetry.ts`), as a tag error posted to `v1/t`
without cookies, from 10 % of page loads (the config's `telemetry.error_sample_rate` sets another
share) and at most 5 per page.

A site's config with `paused: true`, its kill switch ("pause tracking"), stops the tag right after
the config fetch, which is then the page's only request: no command runs (the site's calls stay
queued on the stub), no pageview is made, no consent source or consent manager's adapter is loaded,
a pinned `bundle_version` is not loaded, and no tag error is sent from then on. With `paused: false`
or none, the tag runs normally. A `paused` that isn't a boolean is a config error: the tag doesn't
run, and reports it.

The transport (`src/core/transport.ts`) is built but not yet fed: it posts events and pings to
`v1/e` in batches of up to 10, sent 2 s after the first is buffered, at the 10th, or at once for a
pageview. A batch that meets a network error or a 5xx is retried twice (after 1 s, then 3 s) and
then dropped; one the collector refuses otherwise is dropped and reported as a tag error. On
`pagehide` it sends what is buffered or awaiting a retry with `sendBeacon` (pings, which must not
carry cookies, and any batch `sendBeacon` refuses go with a `keepalive` fetch instead). Each event
batch carries `seq`, the page's batch counter from 1, whose gaps show lost batches, `page_id`,
a random UUIDv4 made once per pageload that links the page's batches, and
`"webdriver": true` when `navigator.webdriver` is `true`. Its queues live
in memory only: no cookie, `localStorage` or IndexedDB.

The consent state machine (`src/core/consent.ts`) is built but not yet fed either. It holds two
categories, `analytics` and `ads`, each `granted`, `denied`, `unknown` or `no_cmp`, and the
analytics state decides how an item is collected: with the visitor's ids when granted; per the
site's declined mode when denied (the config's `consent.declined_mode`: `pings` sends anonymous
pings, `off`, the default, sends nothing); held in memory, at most 100 per page, while unknown; and
for `no_cmp`, as the site's no-CMP policy resolves it, held until it does. The ads state rides each
event's consent snapshot. Held items go with the ids on a grant, and per the declined mode on a
denial or on `pagehide` while still undecided, so an `off` site drops them. A denial deletes the
visitor's ids at once, and a grant after a denial mints fresh ones, so earlier pings are never
linked to the visitor.

The consent sources (`src/core/consent-sources.ts`) drive the machine once boot is given it (its
`consent` option, not yet passed by `a.js`). They form a ladder, highest first:

- **gpc**: Global Privacy Control. When the browser sends it (`navigator.globalPrivacyControl` is
  `true`), the tag denies both `analytics` and `ads` at boot, before any other source is read, and
  collects per the site's declined mode. Nothing grants anything on that page afterwards: neither
  the site's banner nor Consent Mode. GPC is a binding opt-out in California and Colorado, so it is
  honored by default. A site can turn this off with its config's `consent.gpc_honored: false`.
  Legacy Do Not Track (`navigator.doNotTrack` and the `DNT` header) is deprecated and is
  deliberately ignored: it neither denies nor grants.
- **manual**: the site's own banner calls `amanda('consent', {analytics: "granted", ads: "denied"})`.
  Each category is `"granted"` or `"denied"`; a category left out keeps its state. Anything else is
  refused and reported, never guessed.
- **gcm**: Google Consent Mode v2, read from `window.dataLayer`: the `gtag('consent', 'default' |
  'update', ...)` entries already there at boot, then each one pushed later. `analytics` follows
  `analytics_storage`; `ads` is denied when `ad_storage` or `ad_user_data` is, and granted only when
  both are. An update overrides a default, a later default never overrides an update, and a default
  scoped to `region`s is skipped, as the tag doesn't know the visitor's region.
- **tcf**: an IAB TCF v2.2 consent manager, followed through `__tcfapi('addEventListener', 2, ...)`
  when the page has one. On `tcloaded` and `useractioncomplete`, `analytics` is granted when the
  visitor consented to Purpose 1 (store and access information on a device) and Purpose 8 (measure
  content performance), and `ads` when to Purpose 1 and Purpose 7 (measure advertising performance);
  each is denied otherwise. This is the proposed mapping, pending counsel's sign-off, which gates
  production. While the consent manager's UI is up (`cmpuishown`), or where it says GDPR doesn't
  apply, TCF signals nothing. The snapshot of a TCF signal carries the consent manager's TC string
  as `tc_string`, which is personal data (CJEU C-604/22); a TC string over 8192 characters, or not
  of base64url segments, is left out rather than cut.
- **cookiebot**: a Cookiebot set up without Consent Mode or TCF, read through its own API by the
  Cookiebot adapter (`dist/adapters/cookiebot.js`). The core loads the adapter only on a page that
  has Cookiebot: `window.Cookiebot` is there at boot, or Cookiebot fires `CookiebotOnLoad` or
  `CookiebotOnConsentReady` later; any other page never requests it. The adapter connects back
  through `amanda('adapter', 'cookiebot', ...)`, reads Cookiebot's consent at once and again on each
  `CookiebotOnConsentReady` (an answer read from its cookie, given, or changed). `analytics` follows
  Cookiebot's `statistics` category and `ads` its `marketing` one. Until the visitor has answered
  (`Cookiebot.hasResponse` is not `true`), it signals nothing. A Cookiebot set up with Consent Mode
  or TCF is followed through those, which rank above it.
- **onetrust**: a OneTrust set up without Consent Mode or TCF, read through its own API by the
  OneTrust adapter (`dist/adapters/onetrust.js`). The core loads the adapter only on a page that
  has OneTrust: `window.OneTrust` is there at boot, or OneTrust fires `OneTrustGroupsUpdated` later;
  any other page never requests it. The adapter connects back through
  `amanda('adapter', 'onetrust', ...)`, reads `window.OnetrustActiveGroups` at once, and again each
  time OneTrust calls `window.OptanonWrapper` (which the adapter hooks, still calling the site's own)
  or fires `OneTrustGroupsUpdated`: accept, reject and change. `analytics` follows OneTrust's default
  Performance group, `C0002`, and `ads` its Targeting group, `C0004`; a group left out is denied.
  Until the visitor has answered (`OneTrust.IsAlertBoxClosed()` is not `true`), it signals nothing,
  whatever groups OneTrust holds active by default. It ranks below Cookiebot; a page has one or the
  other.
- **usercentrics**: a Usercentrics (its Browser UI, v2) set up without Consent Mode or TCF, read
  through its own API by the Usercentrics adapter (`dist/adapters/usercentrics.js`). The core loads
  the adapter only on a page that has Usercentrics: `window.UC_UI` is there at boot, or Usercentrics
  fires `UC_UI_INITIALIZED` later. The adapter connects back through
  `amanda('adapter', 'usercentrics', ...)`, reads `UC_UI.getServicesBaseInfo()` at once, and again on
  each `UC_UI_INITIALIZED` and `UC_UI_CMP_EVENT`: accept, reject and change. `analytics` follows
  Usercentrics' default Functional category (`functional`), and `ads` its Marketing one
  (`marketing`): a category is granted only when it has services and the visitor explicitly
  consented to each of them, and is denied otherwise. Until the visitor has answered
  (`UC_UI.isConsentRequired()` is not `false`), it signals nothing, whatever the services' defaults.
  It ranks below OneTrust.

The first source to grant or deny a category wins, and its later signals always apply. A higher
source takes over from a lower one as soon as it signals (the manual API from Consent Mode, Consent
Mode from TCF, TCF from Cookiebot, Cookiebot from OneTrust, OneTrust from Usercentrics), and a lower one never takes over from a higher one. The snapshot
every event carries names its `source` (`gpc`, `manual`, `gcm`, `tcf`, `cookiebot`,
`onetrust` or `usercentrics`), and only a `tcf` snapshot has a `tc_string`.

A site with no consent manager at all says so in its config, `consent.has_cmp: false`; without
that key the tag takes it that the site has one. On such a site both categories start in `no_cmp`,
items wait as they do while `unknown`, and the site's no-CMP policy (`src/core/no-cmp.ts`, the
config's `consent.no_cmp_policy`) decides them:

- **`geo`**, the default: the collector's anonymous jurisdiction hint, `GET /v1/policy`, asked
  without cookies; denied in the EEA, the UK and Switzerland, granted elsewhere. Any answer but a
  well-formed `200` denies, and a server error, a malformed body or a network failure is also
  reported as a tag error (a `429` rate limit is not).
- **`assume_denied`**: always denied, with no request; the safest.
- **`assume_granted`**: always granted, with no request. Badged "check local law" in the control
  plane, which turns it on only with its explicit acknowledgment; never the default, and never the
  recommendation in Germany.

The sources above stay live on such a site: GPC still denies first, and a banner or Consent Mode
that signals after all takes over from the policy's decision. The snapshot of a decided `no_cmp`
keeps `no_cmp` as its states and has no `source`.
Nothing defaults to granted.

The visitor's identity (`src/core/identity.ts`) is built, and driven by the consent machine, but not
yet wired into `a.js` (AAI-964). It is two strictly first-party cookies on the site's own registrable
domain, never on the collection domain:

| Cookie       | Value                                       | Lifetime                          |
| ------------ | ------------------------------------------- | --------------------------------- |
| `_amnda_id`  | `v1.<visitor UUIDv7>`                       | 13 months (395 days), rolling     |
| `_amnda_ses` | `v1.<session UUIDv7>.<last activity, ms>`   | 30 minutes without an event       |

Both are `Domain=.<etld+1>; Path=/; SameSite=Lax; Secure`. The tag finds the registrable domain
without a public-suffix list: it writes a probe cookie on each parent domain, shortest first, and
keeps the first one the browser accepts (a browser refuses a cookie on a public suffix such as
`co.uk`). On an IP address or `localhost` the cookies are host-only; where the browser keeps none (an
`http:` page, cookies blocked), the ids last for the page alone, with a console warning.

- **Only under granted analytics consent.** Nothing is written while consent is unknown or denied;
  every event under a grant renews both cookies' lifetimes, and a session idle for 30 minutes starts
  a new one.
- **Random.** The ids are random UUIDv7s, never derived from personal data, the IP address or the
  device, and each site keeps its own on its own domain.
- **Withdrawal deletes both at once**, on every domain they may be on, those the collector re-issued
  through a first-party proxy included. A grant after a denial mints fresh ids, so the anonymous
  pings sent meanwhile are never linked to the visitor.
- **Purge on withdrawal, off by default.** A site whose config turns `consent.purge_on_withdrawal`
  on (AAI-226) has the withdrawal erase what is stored about the visitor too: just before deleting
  the cookies, the tag posts the withdrawal signal (`src/core/withdrawal.ts`) to `v1/w` with the
  visitor ID of `_amnda_id`, and the processor erases that visitor through the DSAR cascade delete.
  The signal carries the visitor ID and nothing about the page, and goes without cookies and with
  `keepalive`. It is sent once per withdrawal, in either declined mode, `off` included, and only
  when there is a visitor ID to erase: a visitor who never granted sends none. It is not retried: a
  5xx or a network error is logged in the console, and a refusal is reported as a tag error. The
  cookies are deleted in every case. Without the option, a withdrawal deletes the cookies and sends
  nothing.
- **Safari's limit, accepted.** Safari's Intelligent Tracking Prevention caps cookies a script
  writes at 7 days, or 24 hours when the visitor arrived from a link with tracking decoration, so a
  Safari visitor returning after that counts as new. The tag does not work around it. The way to keep
  the cookies their full lifetime is a [first-party reverse proxy](docs/first-party-proxy.md) that
  the customer runs, through which the collector re-issues them (AAI-827, AAI-831); Amanda does not
  host one.
- **The visitor can read their own ID.** `amanda('privacy')` (`src/core/privacy.ts`) opens a dialog
  over the page that shows the visitor the visitor ID of their `_amnda_id` cookie (the UUID, without
  the cookie's `v1.` prefix), with a button that copies it. A site links it from its privacy policy,
  for example `<a href="#" onclick="amanda('privacy'); return false">Show my visitor ID</a>`, and the
  visitor gives the ID to the site, which finds them by it in the DSAR tool. Without the cookie (no
  analytics consent, or it was withdrawn) the dialog says that no ID exists without consent. The
  helper only reads the cookie: it never mints an ID or writes one. Where the browser refuses the
  copy, or has no Clipboard API, it selects the ID and asks the visitor to copy it themselves. Its
  texts are in English.
- **identify(), off by default.** `amanda('identify', ref)` (`src/core/identify.ts`) links the
  visitor to the site's own pseudonymous reference for its logged-in user, such as a hashed customer
  number, for logged-in stitching: it sends one `identify` event carrying the ref as `user_ref`. It
  works only on a site whose config turns it on (`features.identify_enabled: true`); elsewhere the
  call is refused and reported. Raw email addresses are refused in the browser: a ref holding an
  `@` is never sent, and neither is one that isn't a non-empty string or is over 128 characters.
  The tag keeps no ref, in memory or in a cookie: the site calls identify on each page its user is
  logged in on. Like every event, the identify event goes only under granted analytics, never as a
  ping.
- **purchase().** `amanda('purchase', {order_id, revenue, currency, items})` (`src/core/purchase.ts`),
  on the order confirmation page, sends one `purchase` event carrying the order as its `purchase`:
  `order_id`, `revenue` (0 or more, in the currency's major unit), `currency` (ISO 4217; lower case
  is upper-cased) and, optionally, 1 to 50 `items` of `{sku, name?, qty, price}`. The order is held
  to the wire schema in the browser: one the collector would refuse (a revenue given as a string, a
  missing `order_id`, a `qty` of 1.5) is not sent, and the refusal is reported. A key the schema
  doesn't list is left out, with a console warning. Purchases are deduplicated by `order_id`, so a
  reloaded confirmation page counts once. In declined mode `pings` the purchase goes as a count-only
  anonymous ping, without any of the order's fields.
- **Custom events.** `amanda('event', name, props)` (`src/core/custom-event.ts`) sends one event of
  the site's own, such as `amanda('event', 'signup', {plan: 'pro'})`: its `type` is the name and its
  `props` the props. The name is a non-empty string of at most 64 characters, and never the type of
  an event the tag sends itself (`pageview`, `page_exit`, `form_submit`, `click_special`,
  `click_outbound`, `scroll`, `identify`, `purchase`, `view_item`, `add_to_cart`, `begin_checkout`).
  `props` is optional: a flat object of at most 25 keys, none starting with `am_`, each value a
  string of at most 200 characters, a finite number or a boolean; a key whose value is `undefined` is
  left out. Anything else is refused in the browser and reported, never cut or coerced. A custom
  event goes only under granted analytics, and never as a ping: in declined mode `pings` it sends
  nothing. It is the command the GTM template's custom event type calls.

Attribution (`src/core/attribution.ts`) is captured on each landing, the page load's first
pageview, from the landing URL's query string: the UTM set (`utm_source`, `utm_medium`,
`utm_campaign`, `utm_term`, `utm_content`, `utm_id`, `utm_source_platform`, `utm_creative_format`,
`utm_marketing_tactic`), the click IDs `gclid`, `gbraid`, `wbraid`, `fbclid` and `msclkid`, and the
parameters the site's config names in `custom_params` (a list of up to 25 names). The pageview
carries them as its `attribution`; a route change of a single-page app is no landing and carries
none. Values are sent verbatim, never case-normalised (`Summer` and `summer` stay distinct) and
never classified: the collector caps each at 200 characters, and the processor classifies them.
Click IDs are identifiers: while `ads` is denied, an event carries none, neither in its
`attribution` nor in the `url` and `referrer` it sends, while its UTMs and custom parameters, which
are campaign labels, still go (`gateClickIds`, to be applied on the identified path by AAI-964). An
anonymous ping never carries any of it but its five frozen UTM fields.

The canary pin (`src/core/canary.ts`) rolls a new build out to chosen sites without a separate
loader. A site's config may carry `bundle_version`, a tag version; when it names a build other than
the running one, the tag doesn't start, but appends one script tag for `a.<bundle_version>.js` from
its endpoint (the collection host or the page's own origin, as adapters), with the snippet's
`data-site` and `data-endpoint`, and that build boots in its place, with the snippet's stub and its
queued calls. That is one extra request, on pinned sites only; an unpinned config, or one that names
the running build, never makes it. The pinned build's script tag is marked
`data-amanda-handoff-from="<version>"`, and a build booted from a marked tag never hands off again,
so a page loads at most one pinned build. A pinned build that fails to load is reported as a tag
error, and the running build starts instead. A `bundle_version` that isn't a tag version is a config
error. Every event and tag error carries the `tag_version` of the build that sent it, so a canary
cohort's telemetry separates from everyone else's.

Still to come:

- the collector accepting `POST /v1/t` and the event debugger showing tag errors (amandatracker);
- pageviews fed through the consent state machine, made into events (with the identity's ids) or
  pings, and handed to the transport, with the machine handed to boot so the sources drive it
  (AAI-964, AAI-965);
- the config publisher writing `consent.has_cmp` (amandatracker, AAI-94's follow-up): until it
  does, every site counts as having a consent manager and the no-CMP policy is never followed;
- the config publisher writing `features.ga4_ecommerce_enabled`, and its portal toggle
  (amandatracker): until it does, the GA4 e-commerce auto-map stays off on every site.

Where this README or a guide describes what the tag does at runtime, it describes the design these
tickets build, and says so.

## Google Tag Manager

`template.tpl` is the tag's Google Tag Manager Community Template: a loader and a consent bridge,
never a second tracker. It injects the same `a.js` as the snippet, as
`https://eu.serversider.com/a.js?site=<Site ID>` (GTM's `injectScript` sets no attributes, so the
site goes in the query), and forwards to `window.amanda`, whose calls queue until `a.js` has loaded.

- **Fields:** the Site ID, the only required one; the event type, which is Initialization by default,
  or a custom event (`amanda('event', name, props)`) or a purchase (`amanda('purchase', order)`,
  which reads GA4's `item_id`, `item_name` and `quantity` as `sku`, `name` and `qty`); an endpoint
  override, for a first-party proxy; and the consent bridge, on by default.
- **Trigger:** fire the Initialization type on *Initialization - All Pages*, never on a
  consent-gated trigger: the tag decides what it may send itself, and gating it would silently turn
  off declined-mode pings.
- **The consent bridge** forwards `analytics_storage`, and `ad_storage` with `ad_user_data`, to
  `amanda('consent', ...)`: each type GTM has set to denied, at once, and each change GTM's consent
  listener reports. GTM's `isConsentGranted` is also true for a type it has no state for, so it is
  never forwarded as a grant. A grant GTM writes to the dataLayer also reaches the tag through its
  own Consent Mode source.
- **Permissions, and nothing beyond them:** `inject_script` for `https://eu.serversider.com/a.js*`
  only; `access_globals` for `amanda` and `amanda.q` only; `access_consent`, reading those three
  consent types and writing none; and `logging`, in debug mode only.

`test/gtm-template.test.ts` runs the template's code against the tag's real command queue and
commands, and checks its permissions. The template's own `___TESTS___` run in GTM's template editor.

The template is published through GTM's Community Template Gallery, which reads `template.tpl`,
`metadata.yaml` and `LICENSE` from this repository's root: see
[The Community Template Gallery](docs/gtm-gallery.md) for the package, the submission and how a new
version is released. [Amanda Tracker in Google Tag Manager](docs/google-tag-manager.md) is the
documentation the gallery links.

## The npm package

A site that bundles its front end can install the tag as a package instead of a script tag. It is
the same tag as `a.js`, from the same source: both entry points start it with `startTag`
(`src/core/tag.ts`), and the package is built with the same version and adapter hashes, so it loads
that release's adapters.

```js
import { amanda, init } from "amandatracker-tag";

amanda("consent", { analytics: "granted", ads: "denied" }); // queues until the tag has booted
init({ site: "<SITE_PUBLIC_ID>" }); // or { site, endpoint: "/amnda" } behind a first-party proxy
amanda("event", "signup", { plan: "pro" });
```

- `init({ site, endpoint })` starts the tag, with the site and endpoint that `data-site` and
  `data-endpoint` give `a.js`. Call it once, in the browser. It settles with `true` once the tag has
  booted, or `false` when it didn't: the failure was reported, `a.js` or an earlier `init` already
  runs on the page, or the site's kill switch is on.
- `amanda(command, ...args)` is `window.amanda`, the command queue: a call before `init`, or while
  the config loads, queues as a call to the snippet's stub does.
- Importing the package starts nothing (`sideEffects: false`). `init` and `amanda` throw on a server,
  where there is no `window`; call them from browser-only code, such as an effect.
- A config's pinned `bundle_version` is never loaded in the package's place: the site chose the
  package's version when it bundled it.

`pnpm build` builds it to `dist/npm/` (`scripts/build-npm.mjs`): one ES module, ES2018 and
unminified (the site's bundler minifies it), its type declarations, `package.json` and `LICENSE`.
`test/npm-package.test.ts` installs it in a site's `node_modules`, bundles a site with esbuild, and
checks that its pageview reaches `v1/e`. The package isn't published to npm yet.

## Guides

- [Amanda Tracker in Google Tag Manager](docs/google-tag-manager.md): install the tag with the
  Community Template, bridge GTM's consent, and send custom events and purchases.
- [First-party reverse proxy](docs/first-party-proxy.md): serve the tag and its collection endpoint from
  your own site, so Safari keeps the tracker's cookies for their full lifetime.
- [Verifying a release](docs/verifying-a-release.md): rebuild a published `a.<version>.js` from its
  tag and provenance, and check that it is byte for byte what is served.

## Development

Needs Node.js 20 or later and pnpm 9.

```sh
pnpm install
pnpm typecheck   # TypeScript, strict; src/ alone also as browser code (tsconfig.src.json: ES2018 + DOM, no Node types)
pnpm test        # Vitest
pnpm build       # dist/a.js, dist/adapters/*.js, the size gate, dist/schema/, then the npm package in dist/npm/
pnpm gen:wire    # src/wire/generated.ts from the wire schema
pnpm reproduce <a.<version>.provenance.json>   # rebuild a release and compare it byte for byte
pnpm gtm:check   # metadata.yaml's GTM gallery versions against origin/main (--ref <ref> for another)
```

## The wire schema

`schema/v<N>/` holds the wire contract as JSON Schema (draft 2020-12). It is the single source of
truth for what the tag sends and what the collector accepts:

- `event.json`: the event envelope. It carries the schema and tag versions, `site_id`, a UUIDv7
  `event_id`, `client_ts` in epoch milliseconds, the page fields, the visitor and session ids, and
  the consent snapshot (each category's state, and the `source` that set it: `gpc`, `manual`,
  `gcm`, `tcf`, `cookiebot`, `onetrust` or `usercentrics`, absent when none has). The page load's first pageview carries the landing URL's `attribution`:
  its `utm` set (`source`, `medium`, `campaign`, `term`, `content`, `id`, `source_platform`,
  `creative_format`, `marketing_tactic`), its `click_ids` (`gclid`, `gbraid`, `wbraid`, `fbclid`,
  `msclkid`) and the site's `custom` parameters, each verbatim. Its `props` are flat: at most 25 keys, none starting with `am_`, each value
  a string of at most 200 characters, a number or a boolean. A purchase is a `PurchaseEvent`:
  `type: "purchase"` and a `purchase` object (`order_id`, `revenue`, `currency`, and up to 50
  `items` of `sku`, `name`, `qty` and `price`). No other event carries `purchase`. A page exit is
  a `PageExitEvent`: `type: "page_exit"` and `engagement_ms`, the engagement time since the page
  load's previous page exit (visible time, each span counted up to 15 s after the last
  interaction). The tag sends one by beacon each time the page is hidden after engagement, and one
  for the route a single-page app leaves at each route change, with that route's URL and
  engagement: at least one per pageview. No other event carries `engagement_ms`. A form submission is a
  `form_submit` whose `props` hold only the form's `form_id`, `form_name` and `form_action` (the
  action attribute without its query string and fragment), those it has. Field values are never
  captured, and there is no allowlist or setting that could capture them. Scroll depth, off by
  default, is a `scroll` whose `props` hold `percent_scrolled`, 25, 50, 75 or 90: the tag sends one
  the first time in each pageview the visitor scrolls to that share of the page's height.
  A click (or middle click) on a `tel:` or `mailto:` link is a `ClickSpecialEvent`:
  `type: "click_special"` and `link_scheme`, `tel` or `mailto`. The scheme is all the tag reads of
  the link: never its address, so neither a phone number nor an email address leaves the browser.
  No other event carries `link_scheme`.
  A click (or middle click) on an `http:` or `https:` link that leaves the site's own domains is a
  `click_outbound` carrying `link_host`, the link's hostname alone (lower case, punycode, no trailing
  dot): never its path, query, fragment, port or full URL. Only a `click_outbound` carries
  `link_host`, and it always does.
  GA4 e-commerce auto-map (`src/core/ecommerce.ts`), off unless configured, reads a GA4-tagged
  shop's `view_item`, `add_to_cart`, `begin_checkout` and `purchase` from `window.dataLayer`, both
  as Google Tag Manager pushes them (`{event, ecommerce}`) and as `gtag('event', ...)` does, and
  maps each by an explicit table to an event of the same name. The first three carry `props` of
  `currency`, `value` and `item_count`, plus `item_id` and `item_name` when the event has one item.
  A `purchase` becomes a `PurchaseEvent`: `transaction_id` is its `order_id`, `value` its
  `revenue` and `currency` its currency, and each item's `item_id`, `item_name`, `quantity` (1 when
  left out) and `price` its `sku`, `name`, `qty` and `price`. Nothing is guessed: a purchase
  without a transaction ID, a value and a currency code isn't sent, and one whose items don't all
  map, or are over 50, goes without them, each with a console warning. Any other GA4 event is
  ignored. A site turns it on with `features.ga4_ecommerce_enabled: true` in its config; absent or
  `false`, the tag neither reads nor wraps the dataLayer, and any other value is a config error. The
  mapped events go through the consent machine as a pageview does: under granted analytics each is
  an event; in declined mode `pings` a `purchase` becomes a count-only ping (its type and page,
  never its order), and the other three send nothing.
  An `identify` event carries `user_ref`, the site's own pseudonymous reference for its logged-in
  user (see identify() below): at most 128 characters, and never one holding an `@`, so never an
  email address. Only the identify event carries it.
- `ping.json`: the anonymous ping that declined mode `pings` sends. It has no ids, no `seq` and
  nothing linkable across events. Its field list is frozen after counsel sign-off, so adding a
  field is a framework amendment, never a routine release.
- `batch.json`: the request body of `POST /v1/e`, `{"seq": 3, "page_id": "…", "e": [...]}`. It
  holds 1 to 10 events or pings, never both. A batch of events always carries `seq`, the page's
  batch counter, which the collector reads for loss, and this tag sends `page_id` beside it: a
  random UUIDv4 made once per pageload, in memory only, that links the page's batches (optional in
  the schema, as tags up to v0.4.0 send event batches without it). A batch of pings never carries
  either. A batch of events from a
  browser driven by automation (`navigator.webdriver === true`) also carries `"webdriver": true`, for
  the collector's bot marking; it is absent otherwise, and never on a batch of pings.
- `tag-error.json`: the request body of `POST /v1/t`, one failure the tag's error boundary caught:
  the tag version, the site (when the snippet names a valid one), the stage it failed in (`consent`
  for a consent source it follows, such as Consent Mode's dataLayer), and the
  error's name and message, each URL in the message cut to its scheme and host and each email
  address replaced. It is sent in every consent state, so it carries nothing about the visitor or
  the page: no ids, no URL, no `client_ts`, and an `event_id` whose time is only the hour.
- `withdrawal.json`: the request body of `POST /v1/w`, the withdrawal signal of a site that purges
  on withdrawal (AAI-785): the schema and tag versions, `site_id`, a UUIDv7 `event_id`, `client_ts`
  and the `visitor_id` whose stored data is to be erased. It carries nothing about the page: no URL,
  referrer, session id or consent snapshot.
- `pubsub-message.json`: what the collector publishes to Pub/Sub. It holds the client's event,
  ping or withdrawal signal and the fields the collector derives (received time, region, country,
  device class). For an event it may also carry the ISO 3166-2 `subdivision`, `browser_family`,
  `browser_major` and `os_family`; a ping's or a withdrawal signal's message leaves them off, as a
  ping carries country-level geo only. An event's message also carries its batch's `seq` and
  `page_id` (when the batch had one), which the processor stores for the seq-gap loss metric; a
  ping's or a withdrawal signal's never does. It never includes the IP address.

`pnpm gen:wire` generates `src/wire/generated.ts` from the newest version: types, field lists and
length caps. The payload builder in `src/wire/payload.ts` shapes every payload by them. A test
fails when the committed file differs from what the schema generates.

A breaking change adds a new `schema/v<N+1>/` and leaves `v<N>` as it is. In the copy, each
`$id` ends in `/v<N+1>/<file>` and each `schema_version` is `const: N+1`; `pnpm gen:wire` refuses
a schema that doesn't. `pnpm build` copies
versions N and N−1 to `dist/schema/`, with a `SHA256SUMS` file. The release does not publish
`dist/schema/`: a consumer pins a release tag of this repo, takes `schema/v<N>/` from that tag, and
checks its vendored copy against hashes it records itself (the monorepo's `shared/wire`, AAI-62).

## Build

- `src/core/index.ts` builds to **`dist/a.js`**: a single minified IIFE, ES2018, with no runtime
  dependencies.
- Each consent-manager adapter `src/adapters/<name>.ts` builds to its own IIFE,
  `dist/adapters/<name>.js`, which the core loads only on a page where it detects that consent
  manager (`CMP_ADAPTERS` in `src/core/consent-sources.ts`). The adapter's own code may live
  outside `src/adapters/` (Cookiebot's is `src/cmp/cookiebot.ts`, OneTrust's `src/cmp/onetrust.ts`, Usercentrics' `src/cmp/usercentrics.ts`); the core never imports it. It
  connects back through `amanda('adapter', <name>, connect)` (`src/core/adapter-api.ts`). A name is
  lowercase letters, digits and `-`; the build refuses any other, and fails when `src/adapters/` is
  missing.
- The adapters build first. The core is built with its version (`.release-version`, which the
  release writes, or else `package.json`'s) and each adapter's SHA-384 baked in
  (`src/core/build-info.ts`), and its first line names it: `/*! amandatracker-tag <version> */`.
  Its `loadAdapter` loads `adapters/<version>/<name>.js`, its own
  version's file, with that hash as `integrity` and `crossOrigin = "anonymous"`, and refuses an
  adapter it wasn't built with.
- `src/npm/index.ts` builds to **`dist/npm/`**, the npm package (see [The npm package](#the-npm-package)),
  with the core's version and adapter hashes.

## The endpoint

The tag fetches `cfg/<SITE_PUBLIC_ID>.json` from one base, `https://eu.serversider.com` by default,
or the one the script tag's `data-endpoint` attribute sets. Its transport posts to `v1/e` on the
same base, and a site that purges on withdrawal posts its withdrawal signal to `v1/w` there. Boot loads a detected consent manager's `adapters/<version>/<name>.js` from there too,
once a.js hands it the consent machine (AAI-965); `src/core/endpoint.ts` builds those URLs and
request options. It resolves `data-endpoint` this way:

- a path, such as `data-endpoint="/amnda"`, is on the page's own origin: a
  [first-party reverse proxy](docs/first-party-proxy.md);
- a full URL must be `https:`, or the page's own origin;
- credentials, a query or a fragment are refused.

The transport and boot use its request options (`test/proxied.test.ts` follows a site on
`data-endpoint="/amnda"` from boot to withdrawal). `batchRequestInit` sends event
batches with `credentials: "same-origin"`, so that behind a proxy the browser stores the cookies the
collector re-issues with `Set-Cookie` (AAI-827). It sends ping batches, and `configRequestInit` the
config fetch, with `credentials: "omit"`: they never carry the site's cookies. Every request, adapter
scripts included, sends the page's origin alone as `Referer` (`referrerPolicy: "strict-origin"`),
never its path or query. Only the pagehide flush adds `keepalive`, and `batchRequestInit` refuses a
keepalive body over 60 KiB. The transport splits the pagehide flush, by beacon or keepalive fetch,
into bodies that stay within 60 KiB together with its keepalive fetches still in flight, each event
batch with its own `seq`; the events that don't fit are dropped with a console warning, and their
`seq` gap shows the collector the loss (AAI-893). Browsers refuse a keepalive request once the bodies of all
of a page's keepalive requests in flight would pass 64 KiB, and that quota is shared with
`sendBeacon` and with every other script's beacons on the page (analytics and ad tags firing on the
same pagehide). The 4 KiB left over is a margin, not a reservation: a pagehide request can still be
refused when other tags use more of the quota. When a pagehide keepalive fetch is rejected (fetch
can't say whether for the quota or the network), its events go once more in two smaller bodies,
each a new batch with its own `seq`, and a body rejected again goes once more without `keepalive`,
at best effort, since the page may not outlive it. What is still rejected is dropped with a console
warning, and its `seq` gap shows the loss; the rejected body's own `seq` is a gap too, even when its
events arrive in the halves (AAI-951).

## The size budget

`dist/a.js` must stay within **20 KB gzipped** (20 × 1024 bytes, gzip level 9; raised from the spec's
15 KB when the pageview feed brought the transport, identity and consent machine into the core,
AAI-964). `pnpm build` checks
it after every build and exits non-zero when the bundle is over, so any CI that runs the build fails
on an oversized bundle. `pnpm size` checks an existing `dist/a.js` alone. Adapters are outside the
core budget.

## CI and releases

Cloud Build runs the pipelines in `cloudbuild/`:

- `pr.yaml` checks every pull request: `pnpm install --frozen-lockfile --ignore-scripts`,
  `pnpm typecheck`, `pnpm test` and `pnpm build`, so a core over its size budget fails the check. It
  uploads nothing. The Node image is pinned by digest and pnpm by `packageManager`'s hash: when you
  bump either, update every step's digest, or the hash, in the same commit.
- `release.yaml` runs the same checks, writes the release's provenance (`pnpm provenance`:
  `dist/provenance.json`, an in-toto statement with a SLSA v1 predicate) and rebuilds from it in a
  directory of its own (`pnpm reproduce`), failing unless the second build matches byte for byte.
  Then it uploads the adapters as the immutable `adapters/<version>/<name>.js`, the provenance as
  `a.<version>.provenance.json` and, after them, the core as the immutable `a.<version>.js` to the
  environment's static bucket. Anyone can repeat the check: see
  [Verifying a release](docs/verifying-a-release.md). `scripts/release-version.mjs` picks the version: `package.json`'s on a
  release tag `v<version>` (the two must agree), or `<next patch>-dev.<commit time>.g<short sha>`
  for a build from `main`, such as `0.2.1-dev.20261113185300.gabc1234` after `0.2.0`, so dev builds
  sort after the release they follow and by the commit's UTC time. A prerelease `package.json`
  version keeps its version: `0.1.0-rc.1.dev.<commit time>.g<short sha>`.
  - **dev** (every merge to `main`) also promotes the build to the evergreen `a.js`, and purges it
    from the CDN.
  - **prod** (a release tag, after approval) uploads the versioned files only; promotion to `a.js`
    follows the canary rollout. A release tag on a commit that isn't on `main` fails the build.
