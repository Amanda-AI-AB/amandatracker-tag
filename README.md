# amandatracker-tag

The Amanda Tracker website tag, `a.js`: one script, first-party cookies only, consent-native.
Licensed under Apache-2.0.

## Status

The tag is not yet functional. This repo holds its building blocks: the wire schema and payload
builder, the endpoint and request options (`src/core/endpoint.ts`) and the adapter loader
(`src/core/adapter-loader.ts`). `src/core/index.ts` only re-exports them, and nothing in the built
`a.js` calls them, so the tag does nothing on a page yet. Still to come:

- the command queue, config fetch, pageview and error boundary (AAI-67);
- the transport, which posts batches (AAI-68);
- the `_amnda_id` and `_amnda_ses` cookies (AAI-98);
- `data-endpoint` wired into boot, the transport and withdrawal (AAI-831).

Where this README or a guide describes what the tag does at runtime, it describes the design these
tickets build, and says so.

## Guides

- [First-party reverse proxy](docs/first-party-proxy.md): serve the tag and its collection endpoint from
  your own site, so Safari keeps the tracker's cookies for their full lifetime.

## Development

Needs Node.js 20 or later and pnpm 9.

```sh
pnpm install
pnpm typecheck   # TypeScript, strict; src/ alone also as browser code (tsconfig.src.json: ES2018 + DOM, no Node types)
pnpm test        # Vitest
pnpm build       # dist/a.js, dist/adapters/*.js, the size gate, then dist/schema/
pnpm gen:wire    # src/wire/generated.ts from the wire schema
```

## The wire schema

`schema/v<N>/` holds the wire contract as JSON Schema (draft 2020-12). It is the single source of
truth for what the tag sends and what the collector accepts:

- `event.json`: the event envelope. It carries the schema and tag versions, `site_id`, a UUIDv7
  `event_id`, `client_ts` in epoch milliseconds, the page fields, the visitor and session ids, and
  the consent snapshot. Its `props` are flat: at most 25 keys, none starting with `am_`, each value
  a string of at most 200 characters, a number or a boolean. A purchase is a `PurchaseEvent`:
  `type: "purchase"` and a `purchase` object (`order_id`, `revenue`, `currency`, and up to 50
  `items` of `sku`, `name`, `qty` and `price`). No other event carries `purchase`.
- `ping.json`: the anonymous ping that declined mode `pings` sends. It has no ids, no `seq` and
  nothing linkable across events. Its field list is frozen after counsel sign-off, so adding a
  field is a framework amendment, never a routine release.
- `batch.json`: the request body of `POST /v1/e`, `{"seq": 3, "e": [...]}`. It holds 1 to 10
  events or pings, never both. A batch of events may carry `seq`, the page's batch counter, which
  the collector reads for loss. A batch of pings never carries it.
- `pubsub-message.json`: what the collector publishes to Pub/Sub. It holds the client's event or
  ping and the fields the collector derives (received time, region, country, device class). It
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
  `dist/adapters/<name>.js`, which the core is to load only for the sites whose config names it, once
  it fetches the config (AAI-67). A name is
  lowercase letters, digits and `-`; the build refuses any other, and fails when `src/adapters/` is
  missing.
- The adapters build first. The core is built with its version (`.release-version`, which the
  release writes, or else `package.json`'s) and each adapter's SHA-384 baked in
  (`src/core/build-info.ts`). Its `loadAdapter` loads `adapters/<version>/<name>.js`, its own
  version's file, with that hash as `integrity` and `crossOrigin = "anonymous"`, and refuses an
  adapter it wasn't built with.

## The endpoint

Planned: the tag is to fetch `cfg/<SITE_PUBLIC_ID>.json` (AAI-67), post to `v1/e` (AAI-68) and load
`adapters/<version>/<name>.js` from one base, `https://eu.serversider.com` by default, and the script
tag's `data-endpoint` attribute is to set another (AAI-831). `src/core/endpoint.ts` already builds
those URLs and request options; nothing calls them yet. It resolves `data-endpoint` this way:

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
(AAI-68). Browsers refuse a keepalive request once the bodies of all
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

- `pr.yaml` checks every pull request: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`
  and `pnpm build`, so a core over its size budget fails the check. It uploads nothing.
- `release.yaml` runs the same checks, then uploads the adapters as the immutable
  `adapters/<version>/<name>.js` and, after them, the core as the immutable `a.<version>.js` to the
  environment's static bucket. `scripts/release-version.mjs` picks the version: `package.json`'s on a
  release tag `v<version>` (the two must agree), or `<version>-dev.g<short sha>` for a build from
  `main`.
  - **dev** (every merge to `main`) also promotes the build to the evergreen `a.js`, and purges it
    from the CDN.
  - **prod** (a release tag, after approval) uploads the versioned files only; promotion to `a.js`
    follows the canary rollout.
