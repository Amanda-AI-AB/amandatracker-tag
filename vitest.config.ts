import { defineConfig } from "vitest/config";

export default defineConfig({
  // What scripts/build.mjs bakes into a build (src/core/build-info.ts): a fixed version, and four
  // adapters, example-cmp, cookiebot, onetrust and usercentrics, with stand-in hashes.
  define: {
    __TAG_VERSION__: JSON.stringify("0.0.0-test"),
    __ADAPTER_INTEGRITY__: JSON.stringify({ "example-cmp": "sha384-test", cookiebot: "sha384-test-cookiebot", onetrust: "sha384-test-onetrust", usercentrics: "sha384-test-usercentrics" }),
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
