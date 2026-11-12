import { describe, expect, it } from "vitest";
import { adapterUrl } from "../src/core/adapter-loader";

describe("adapterUrl", () => {
  it("points at the adapter's own file beside the core", () => {
    expect(adapterUrl("https://eu.serversider.com/", "example-cmp")).toBe(
      "https://eu.serversider.com/adapters/example-cmp.js",
    );
  });

  it("refuses a name that could leave the adapters directory", () => {
    expect(() => adapterUrl("https://eu.serversider.com", "../evil")).toThrow("invalid adapter name");
  });
});
