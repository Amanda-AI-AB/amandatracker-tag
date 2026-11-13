import { defineConfig } from "vitest/config";

export default defineConfig({
  // What scripts/build.mjs bakes into a build (src/core/build-info.ts): a fixed version, and one
  // adapter, example-cmp, with a stand-in hash.
  define: {
    __TAG_VERSION__: JSON.stringify("0.0.0-test"),
    __ADAPTER_INTEGRITY__: JSON.stringify({ "example-cmp": "sha384-test" }),
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
