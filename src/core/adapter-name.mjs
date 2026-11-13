// A consent-manager adapter's name: its file src/adapters/<name>.ts, its build dist/adapters/<name>.js
// and the name a site's config gives it. Plain JavaScript, so that scripts/build.mjs, which node runs
// without a TypeScript loader, checks file names with the very regex adapterUrl checks names with.
export const ADAPTER_NAME = /^[a-z0-9-]+$/;
