// What scripts/build.mjs bakes into a build with esbuild's define (vitest.config.ts defines test
// values): the version the core is published under, and the SRI hash of each adapter built with it.
// The core loads only its own version's adapters (adapters/<version>/<name>.js), each pinned by its
// hash, so a cached or pinned a.<version>.js never runs an adapter built for another core.

declare const __TAG_VERSION__: string;
declare const __ADAPTER_INTEGRITY__: { readonly [name: string]: string };

export const TAG_VERSION: string = __TAG_VERSION__;

/** Adapter name → its file's integrity metadata, `sha384-<base64>`. */
export const ADAPTER_INTEGRITY: { readonly [name: string]: string } = __ADAPTER_INTEGRITY__;
