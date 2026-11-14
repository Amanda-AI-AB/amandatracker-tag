# amandatracker-tag

The Amanda Tracker website tag, `a.js`: one script, first-party cookies only, consent-native.
Licensed under Apache-2.0.

## Status

The tag boots, but sends no events yet. `a.js` (`src/core/boot.ts`) reads its script tag's `data-site`
and `data-endpoint`, fetches the site's config from `cfg/<SITE_PUBLIC_ID>.json` without cookies,
replaces the snippet's `window.amanda` stub with the real command function and runs the calls it
queued, then makes a pageview on load and on each route change of a single-page app
(`history.pushState`, `history.replaceState` and `popstate`; a fragment-only change is not a new
page). Every step runs inside an error boundary (`src/core/boundary.ts`): a failure never reaches the
host page. It is reported instead (`src/core/telemetry.ts`), as a tag error posted to `v1/t`
without cookies, from 10 % of page loads (the config's `telemetry.error_sample_rate` sets another
share) and at most 5 per page.

The transport (`src/core/transport.ts`) is built but not yet fed: it posts events and pings to
`v1/e` in batches of up to 10, sent 2 s after the first is buffered, at the 10th, or at once for a
pageview. A batch that meets a network error or a 5xx is retried twice (after 1 s, then 3 s) and
then dropped; one the collector refuses otherwise is dropped and reported as a tag error. On
`pagehide` it sends what is buffered or awaiting a retry with `sendBeacon` (pings, which must not
carry cookies, and any batch `sendBeacon` refuses go with a `keepalive` fetch instead). Each event
batch carries `seq`, the page's batch counter from 1, whose gaps show lost batches. Its queues live
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

The first source to grant or deny a category wins, and its later signals always apply. A higher
source takes over from a lower one as soon as it signals (the manual API from Consent Mode, Consent
Mode from TCF, TCF from Cookiebot), and a lower one never takes over from a higher one. The snapshot
every event carries names its `source` (`gpc`, `manual`, `gcm`, `tcf` or `cookiebot`), and only a
`tcf` snapshot has a `tc_string`.
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
- **Safari's limit, accepted.** Safari's Intelligent Tracking Prevention caps cookies a script
  writes at 7 days, or 24 hours when the visitor arrived from a link with tracking decoration, so a
  Safari visitor returning after that counts as new. The tag does not work around it. The way to keep
  the cookies their full lifetime is a [first-party reverse proxy](docs/first-party-proxy.md) that
  the customer runs, through which the collector re-issues them (AAI-827, AAI-831); Amanda does not
  host one.

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
- the other consent sources: the no-CMP policy (AAI-94) and the OneTrust and Usercentrics
  adapters (AAI-164, AAI-165);
- the pagehide flush split by size to stay within the keepalive quota (AAI-893, AAI-951);
- `data-endpoint` wired into boot, the transport and withdrawal (AAI-831).

Where this README or a guide describes what the tag does at runtime, it describes the design these
tickets build, and says so.

## Guides

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
pnpm build       # dist/a.js, dist/adapters/*.js, the size gate, then dist/schema/
pnpm gen:wire    # src/wire/generated.ts from the wire schema
pnpm reproduce <a.<version>.provenance.json>   # rebuild a release and compare it byte for byte
```

## The wire schema

`schema/v<N>/` holds the wire contract as JSON Schema (draft 2020-12). It is the single source of
truth for what the tag sends and what the collector accepts:

- `event.json`: the event envelope. It carries the schema and tag versions, `site_id`, a UUIDv7
  `event_id`, `client_ts` in epoch milliseconds, the page fields, the visitor and session ids, and
  the consent snapshot (each category's state, and the `source` that set it: `gpc`, `manual`,
  `gcm`, `tcf` or `cookiebot`, absent when none has). The page load's first pageview carries the landing URL's `attribution`:
  its `utm` set (`source`, `medium`, `campaign`, `term`, `content`, `id`, `source_platform`,
  `creative_format`, `marketing_tactic`), its `click_ids` (`gclid`, `gbraid`, `wbraid`, `fbclid`,
  `msclkid`) and the site's `custom` parameters, each verbatim. Its `props` are flat: at most 25 keys, none starting with `am_`, each value
  a string of at most 200 characters, a number or a boolean. A purchase is a `PurchaseEvent`:
  `type: "purchase"` and a `purchase` object (`order_id`, `revenue`, `currency`, and up to 50
  `items` of `sku`, `name`, `qty` and `price`). No other event carries `purchase`. A page exit is
  a `PageExitEvent`: `type: "page_exit"` and `engagement_ms`, the engagement time since the page
  load's previous page exit (visible time, each span counted up to 15 s after the last
  interaction). The tag sends one by beacon each time the page is hidden after engagement, and at
  least one per page load. No other event carries `engagement_ms`.
- `ping.json`: the anonymous ping that declined mode `pings` sends. It has no ids, no `seq` and
  nothing linkable across events. Its field list is frozen after counsel sign-off, so adding a
  field is a framework amendment, never a routine release.
- `batch.json`: the request body of `POST /v1/e`, `{"seq": 3, "e": [...]}`. It holds 1 to 10
  events or pings, never both. A batch of events always carries `seq`, the page's batch counter,
  which the collector reads for loss. A batch of pings never carries it.
- `tag-error.json`: the request body of `POST /v1/t`, one failure the tag's error boundary caught:
  the tag version, the site (when the snippet names a valid one), the stage it failed in (`consent`
  for a consent source it follows, such as Consent Mode's dataLayer), and the
  error's name and message, each URL in the message cut to its scheme and host and each email
  address replaced. It is sent in every consent state, so it carries nothing about the visitor or
  the page: no ids, no URL, no `client_ts`, and an `event_id` whose time is only the hour.
- `pubsub-message.json`: what the collector publishes to Pub/Sub. It holds the client's event or
  ping and the fields the collector derives (received time, region, country, device class). For an
  event it may also carry the ISO 3166-2 `subdivision`, `browser_family`, `browser_major` and
  `os_family`; a ping's message leaves them off, as a ping carries country-level geo only. It
  never includes the IP address.

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
  outside `src/adapters/` (Cookiebot's is `src/cmp/cookiebot.ts`); the core never imports it. It
  connects back through `amanda('adapter', <name>, connect)` (`src/core/adapter-api.ts`). A name is
  lowercase letters, digits and `-`; the build refuses any other, and fails when `src/adapters/` is
  missing.
- The adapters build first. The core is built with its version (`.release-version`, which the
  release writes, or else `package.json`'s) and each adapter's SHA-384 baked in
  (`src/core/build-info.ts`), and its first line names it: `/*! amandatracker-tag <version> */`.
  Its `loadAdapter` loads `adapters/<version>/<name>.js`, its own
  version's file, with that hash as `integrity` and `crossOrigin = "anonymous"`, and refuses an
  adapter it wasn't built with.

## The endpoint

The tag fetches `cfg/<SITE_PUBLIC_ID>.json` from one base, `https://eu.serversider.com` by default,
or the one the script tag's `data-endpoint` attribute sets. Its transport posts to `v1/e` on the
same base. Boot loads a detected consent manager's `adapters/<version>/<name>.js` from there too,
once a.js hands it the consent machine (AAI-965); `src/core/endpoint.ts` builds those URLs and
request options. It resolves `data-endpoint` this way:

- a path, such as `data-endpoint="/amnda"`, is on the page's own origin: a
  [first-party reverse proxy](docs/first-party-proxy.md);
- a full URL must be `https:`, or the page's own origin;
- credentials, a query or a fragment are refused.

Its request options are the ones the transport and boot are to use. `batchRequestInit` sends event
batches with `credentials: "same-origin"`, so that behind a proxy the browser stores the cookies the
collector re-issues with `Set-Cookie` (AAI-827). It sends ping batches, and `configRequestInit` the
config fetch, with `credentials: "omit"`: they never carry the site's cookies. Every request, adapter
scripts included, sends the page's origin alone as `Referer` (`referrerPolicy: "strict-origin"`),
never its path or query. Only the pagehide flush adds `keepalive`, and `batchRequestInit` refuses a
keepalive body over 60 KiB; keeping the flush's bodies within 60 KiB together is the transport's job
(AAI-893; until then a larger pagehide batch is reported and lost). Browsers refuse a keepalive request once the bodies of all
of a page's keepalive requests in flight would pass 64 KiB, and that quota is shared with
`sendBeacon` and with every other script's beacons on the page (analytics and ad tags firing on the
same pagehide). The 4 KiB left over is a margin, not a reservation: a pagehide request can still be
refused when other tags use more of the quota.

## The size budget

`dist/a.js` must stay within **15 KB gzipped** (15 × 1024 bytes, gzip level 9). `pnpm build` checks
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
