# amandatracker-tag

The Amanda Tracker website tag, `a.js`: one script, first-party cookies only, consent-native.
Licensed under Apache-2.0.

## Guides

- [First-party reverse proxy](docs/first-party-proxy.md): serve the tag and its collection endpoint from
  your own site, so Safari keeps the tracker's cookies for their full lifetime.

## Development

Needs Node.js 20 or later and pnpm 9.

```sh
pnpm install
pnpm typecheck   # TypeScript, strict
pnpm test        # Vitest
pnpm build       # dist/a.js, dist/adapters/*.js, the size gate, then dist/schema/
pnpm gen:wire    # src/wire/generated.ts from the wire schema
```

## The wire schema

`schema/v<N>/` holds the wire contract as JSON Schema (draft 2020-12). It is the single source of
truth for what the tag sends and what the collector accepts:

- `event.json`: the event envelope. It carries the schema and tag versions, `site_id`, a UUIDv7
  `event_id`, `client_ts` in epoch milliseconds, the page fields, the visitor and session ids, and
  the consent snapshot.
- `ping.json`: the anonymous ping that declined mode `pings` sends. It has no ids, no `seq` and
  nothing linkable across events. Its field list is frozen after counsel sign-off, so adding a
  field is a framework amendment, never a routine release.
- `pubsub-message.json`: what the collector publishes to Pub/Sub. It holds the client's event or
  ping and the fields the collector derives (received time, region, country, device class). It
  never includes the IP address.

`pnpm gen:wire` generates `src/wire/generated.ts` from the newest version: types, field lists and
length caps. The payload builder in `src/wire/payload.ts` shapes every payload by them. A test
fails when the committed file differs from what the schema generates.

A breaking change adds a new `schema/v<N+1>/` and leaves `v<N>` as it is. `pnpm build` copies
versions N and N−1 to `dist/schema/`, with a `SHA256SUMS` file for consumers that pin a tagged
release.

## Build

- `src/core/index.ts` builds to **`dist/a.js`**: a single minified IIFE, ES2018, with no runtime
  dependencies.
- Each consent-manager adapter `src/adapters/<name>.ts` builds to its own IIFE,
  `dist/adapters/<name>.js`, which the core loads only for the sites whose config names it.

## The endpoint

The tag fetches `cfg/<SITE_PUBLIC_ID>.json`, posts to `v1/e` and loads `adapters/<name>.js` from one
base, `https://eu.serversider.com` by default. The script tag's `data-endpoint` attribute sets
another (`src/core/endpoint.ts`):

- a path, such as `data-endpoint="/amnda"`, is on the page's own origin: a
  [first-party reverse proxy](docs/first-party-proxy.md);
- a full URL must be `https:`, or the page's own origin;
- credentials, a query or a fragment are refused.

Batches go out with `credentials: "same-origin"`, so that behind a proxy the browser stores the
cookies the collector re-issues with `Set-Cookie`. Only the pagehide flush adds `keepalive`, and
its bodies stay within 60 KiB together: browsers refuse keepalive bodies over 64 KiB in flight.

## The size budget

`dist/a.js` must stay within **15 KB gzipped** (15 × 1024 bytes, gzip level 9). `pnpm build` checks
it after every build and exits non-zero when the bundle is over, so any CI that runs the build fails
on an oversized bundle. `pnpm size` checks an existing `dist/a.js` alone. Adapters are outside the
core budget.
