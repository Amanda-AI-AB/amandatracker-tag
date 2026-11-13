import { describe, expect, it } from "vitest";
import { loadAdapter } from "../src/core/adapter-loader";
import { DEFAULT_ENDPOINT, EndpointError, resolveEndpoint } from "../src/core/endpoint";

const PAGE = "https://shop.example.com";

type FakeScript = {
  async?: boolean;
  referrerPolicy?: string;
  src?: string;
  onload?: () => void;
  onerror?: () => void;
};

function fakeDocument() {
  const appended: FakeScript[] = [];
  const doc = {
    createElement: () => ({}) as FakeScript,
    head: { appendChild: (script: FakeScript) => appended.push(script) },
  } as unknown as Document;
  return { doc, appended };
}

describe("loadAdapter", () => {
  it("injects the adapter's file from the resolved endpoint, async", async () => {
    const { doc, appended } = fakeDocument();
    const loaded = loadAdapter(doc, resolveEndpoint("/amnda/", PAGE), "example-cmp", PAGE);
    expect(appended).toHaveLength(1);
    expect(appended[0]!.src).toBe("https://shop.example.com/amnda/adapters/example-cmp.js");
    expect(appended[0]!.async).toBe(true);
    // the page's origin alone as Referer, never its path or query
    expect(appended[0]!.referrerPolicy).toBe("strict-origin");
    appended[0]!.onload!();
    await expect(loaded).resolves.toBeUndefined();
  });

  it("rejects when the script fails to load", async () => {
    const { doc, appended } = fakeDocument();
    const loaded = loadAdapter(doc, DEFAULT_ENDPOINT, "example-cmp", PAGE);
    appended[0]!.onerror!();
    await expect(loaded).rejects.toThrow(
      "failed to load adapter example-cmp from https://eu.serversider.com/adapters/example-cmp.js",
    );
  });

  it("refuses a name that could leave the adapters directory, before injecting anything", () => {
    const { doc, appended } = fakeDocument();
    expect(() => loadAdapter(doc, DEFAULT_ENDPOINT, "../evil", PAGE)).toThrow("invalid adapter name");
    expect(appended).toHaveLength(0);
  });

  it("refuses an endpoint on another origin, before injecting anything", () => {
    const { doc, appended } = fakeDocument();
    expect(() => loadAdapter(doc, resolveEndpoint("https://evil.example", PAGE), "x", PAGE)).toThrow(EndpointError);
    expect(appended).toHaveLength(0);
  });
});
