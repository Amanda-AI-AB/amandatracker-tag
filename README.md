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
pnpm build       # dist/a.js, dist/adapters/*.js, then the size gate
```

## Build

- `src/core/index.ts` builds to **`dist/a.js`**: a single minified IIFE, ES2018, with no runtime
  dependencies.
- Each consent-manager adapter `src/adapters/<name>.ts` builds to its own IIFE,
  `dist/adapters/<name>.js`, which the core loads only for the sites whose config names it.

## The size budget

`dist/a.js` must stay within **15 KB gzipped** (15 × 1024 bytes, gzip level 9). `pnpm build` checks
it after every build and exits non-zero when the bundle is over, so any CI that runs the build fails
on an oversized bundle. `pnpm size` checks an existing `dist/a.js` alone. Adapters are outside the
core budget.
