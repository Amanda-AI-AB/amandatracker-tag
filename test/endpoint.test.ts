import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BatchSizeError,
  DEFAULT_ENDPOINT,
  EndpointError,
  KEEPALIVE_BODY_LIMIT,
  REFERRER_POLICY,
  adapterUrl,
  batchRequestInit,
  bodyBytes,
  configRequestInit,
  configUrl,
  currentScript,
  endpointFromScript,
  eventsUrl,
  resolveEndpoint,
} from "../src/core/endpoint";
import type { WireBatch } from "../src/wire/generated";
import { EVENT, PING } from "./wire-validator";

const PAGE = "https://shop.example.com";
// location on a page below the site's root, so a relative value shows what it resolves against
const LOCATION = { href: `${PAGE}/sv/checkout?step=2#pay`, origin: PAGE };
const DEV = { href: "http://localhost:8080/sv/checkout", origin: "http://localhost:8080" };

describe("resolveEndpoint", () => {
  it("defaults to the collection host", () => {
    expect(DEFAULT_ENDPOINT).toBe("https://eu.serversider.com");
    expect(resolveEndpoint(null, LOCATION)).toBe(DEFAULT_ENDPOINT);
    expect(resolveEndpoint(undefined, LOCATION)).toBe(DEFAULT_ENDPOINT);
    expect(resolveEndpoint("  ", LOCATION)).toBe(DEFAULT_ENDPOINT);
  });

  it("resolves a relative value against the page's URL, as the browser resolves a link", () => {
    expect(resolveEndpoint("/amnda", LOCATION)).toBe("https://shop.example.com/amnda");
    expect(resolveEndpoint("/amnda/", LOCATION)).toBe("https://shop.example.com/amnda");
    // beside the page, as <script src="amnda/a.js"> on it loads from /sv/amnda/a.js
    expect(resolveEndpoint("amnda", LOCATION)).toBe("https://shop.example.com/sv/amnda");
    expect(resolveEndpoint("../amnda", LOCATION)).toBe("https://shop.example.com/amnda");
  });

  it("accepts any https: endpoint", () => {
    expect(resolveEndpoint("https://t.example.com/amnda/", LOCATION)).toBe("https://t.example.com/amnda");
    expect(resolveEndpoint("https://eu.serversider.com", LOCATION)).toBe(DEFAULT_ENDPOINT);
  });

  it("accepts http: only on the page's own origin", () => {
    expect(resolveEndpoint("/amnda", DEV)).toBe("http://localhost:8080/amnda");
    expect(resolveEndpoint("http://localhost:8080/amnda", DEV)).toBe("http://localhost:8080/amnda");
    expect(() => resolveEndpoint("http://other.example.com/amnda", DEV)).toThrow(EndpointError);
  });

  it("rejects other schemes, naming the scheme", () => {
    for (const value of ["http://shop.example.com/amnda", "javascript:alert(1)", "data:text/plain,x"]) {
      expect(() => resolveEndpoint(value, LOCATION)).toThrow(EndpointError);
    }
    expect(() => resolveEndpoint("javascript:alert(1)", LOCATION)).toThrow("not javascript:");
  });

  it("rejects a blob: URL of the page's own origin, whose pathname is a whole URL", () => {
    expect(new URL("blob:https://shop.example.com/abc").origin).toBe(PAGE);
    expect(() => resolveEndpoint("blob:https://shop.example.com/abc", LOCATION)).toThrow(
      "data-endpoint must be https:, or http: on the page's own origin, not blob:: blob:https://shop.example.com/abc",
    );
  });

  it("rejects a file: URL, on a file: page too", () => {
    const file = { href: "file:///home/me/site/index.html", origin: "null" };
    expect(() => resolveEndpoint("amnda", file)).toThrow("not file:");
    expect(() => resolveEndpoint("file:///home/me/site/amnda", file)).toThrow("not file:");
  });

  it("gives a scheme-relative value the page's scheme", () => {
    expect(resolveEndpoint("//t.example.com/amnda", LOCATION)).toBe("https://t.example.com/amnda");
    expect(() => resolveEndpoint("//t.example.com/amnda", DEV)).toThrow(EndpointError);
  });

  it("rejects credentials, a query or a fragment", () => {
    expect(() => resolveEndpoint("https://u:p@t.example.com", LOCATION)).toThrow(EndpointError);
    expect(() => resolveEndpoint("/amnda?x=1", LOCATION)).toThrow(EndpointError);
    expect(() => resolveEndpoint("/amnda#x", LOCATION)).toThrow(EndpointError);
  });

  it("rejects a value that is not a URL, with the parser's error as its cause", () => {
    let caught: unknown;
    try {
      resolveEndpoint("https://", LOCATION);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EndpointError);
    expect((caught as EndpointError).message).toBe("invalid data-endpoint: https://");
    expect((caught as EndpointError).cause).toBeInstanceOf(TypeError);
  });

  describe("on a page of opaque origin", () => {
    // a sandboxed iframe keeps its URL, but its origin is "null"
    const sandboxed = { href: "https://shop.example.com/sv/frame", origin: "null" };
    const srcdoc = { href: "about:srcdoc", origin: "null" };

    it("accepts an https: endpoint", () => {
      expect(resolveEndpoint("https://t.example.com/amnda", sandboxed)).toBe("https://t.example.com/amnda");
      expect(resolveEndpoint("https://t.example.com/amnda", srcdoc)).toBe("https://t.example.com/amnda");
      expect(resolveEndpoint("/amnda", sandboxed)).toBe("https://shop.example.com/amnda");
    });

    it("refuses http:, which is never the page's own origin", () => {
      const dev = { href: "http://localhost:8080/frame", origin: "null" };
      expect(() => resolveEndpoint("/amnda", dev)).toThrow("not http:");
    });

    it("blames the page, not the value, for a relative value it cannot resolve", () => {
      for (const value of ["/amnda", "amnda", "//t.example.com/amnda"]) {
        expect(() => resolveEndpoint(value, srcdoc)).toThrow(
          `a relative data-endpoint cannot resolve against this page's URL, about:srcdoc: ${value}`,
        );
      }
      expect(() => resolveEndpoint("https://", srcdoc)).toThrow("invalid data-endpoint: https://");
    });
  });
});

const element = (tagName: string, endpoint: string | null) =>
  ({ tagName, getAttribute: (name: string) => (name === "data-endpoint" ? endpoint : null) }) as unknown as Element;

describe("endpointFromScript", () => {
  const script = (value: string | null) => element("SCRIPT", value);

  it("reads data-endpoint from the installing script tag", () => {
    expect(endpointFromScript(script("/amnda"), LOCATION)).toBe("https://shop.example.com/amnda");
  });

  it("defaults only for a script without the attribute", () => {
    expect(endpointFromScript(script(null), LOCATION)).toBe(DEFAULT_ENDPOINT);
  });

  it("throws without a script, rather than silently going to the default host", () => {
    expect(() => endpointFromScript(null, LOCATION)).toThrow(EndpointError);
  });

  it("throws for an element that is not a script, such as a clobbering <img name=currentScript>", () => {
    expect(() => endpointFromScript(element("IMG", "https://evil.example"), LOCATION)).toThrow(EndpointError);
    expect(() => endpointFromScript(element("FORM", null), LOCATION)).toThrow(EndpointError);
    // an SVG <script> reports a lowercase tagName
    expect(() => endpointFromScript(element("script", "/amnda"), LOCATION)).toThrow(EndpointError);
  });
});

describe("currentScript", () => {
  const installing = element("SCRIPT", "/amnda");

  // The node test environment has no DOM: a stand-in Document whose prototype getter returns the
  // installing script, as a browser's does.
  class FakeDocument {
    get currentScript(): Element | null {
      return installing;
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the prototype's getter, which a named element cannot shadow", () => {
    vi.stubGlobal("Document", FakeDocument);
    const doc = new FakeDocument();
    Object.defineProperty(doc, "currentScript", { value: element("IMG", "https://evil.example") });
    expect((doc as unknown as Document).currentScript!.tagName).toBe("IMG");
    expect(currentScript(doc as unknown as Document)).toBe(installing);
    expect(endpointFromScript(currentScript(doc as unknown as Document), LOCATION)).toBe(
      "https://shop.example.com/amnda",
    );
  });

  it("throws when Document.prototype has no currentScript getter", () => {
    vi.stubGlobal("Document", class {});
    expect(() => currentScript({} as Document)).toThrow(EndpointError);
  });
});

describe("the endpoint's URLs", () => {
  const endpoint = resolveEndpoint("/amnda", LOCATION);

  it("serves config, events and adapters from the proxy", () => {
    expect(configUrl(endpoint, "SITE_1")).toBe("https://shop.example.com/amnda/cfg/SITE_1.json");
    expect(eventsUrl(endpoint)).toBe("https://shop.example.com/amnda/v1/e");
    expect(adapterUrl(endpoint, "0.3.0", "example-cmp", PAGE)).toBe(
      "https://shop.example.com/amnda/adapters/0.3.0/example-cmp.js",
    );
  });

  it("serves them from the collection host by default", () => {
    expect(configUrl(DEFAULT_ENDPOINT, "SITE_1")).toBe("https://eu.serversider.com/cfg/SITE_1.json");
    expect(eventsUrl(DEFAULT_ENDPOINT)).toBe("https://eu.serversider.com/v1/e");
    expect(adapterUrl(DEFAULT_ENDPOINT, "0.3.0-dev.gabc1234", "example-cmp", PAGE)).toBe(
      "https://eu.serversider.com/adapters/0.3.0-dev.gabc1234/example-cmp.js",
    );
  });

  it("builds every URL from a trailing-slash data-endpoint without a double slash", () => {
    const slashed = resolveEndpoint("/amnda/", LOCATION);
    expect(configUrl(slashed, "SITE_1")).toBe("https://shop.example.com/amnda/cfg/SITE_1.json");
    expect(eventsUrl(slashed)).toBe("https://shop.example.com/amnda/v1/e");
    expect(adapterUrl(slashed, "0.3.0", "example-cmp", PAGE)).toBe(
      "https://shop.example.com/amnda/adapters/0.3.0/example-cmp.js",
    );
  });

  it("escapes the site id in the config path", () => {
    expect(configUrl(endpoint, "a/../b")).toBe("https://shop.example.com/amnda/cfg/a%2F..%2Fb.json");
  });

  it("refuses an adapter name that could leave the adapters directory", () => {
    expect(() => adapterUrl(DEFAULT_ENDPOINT, "0.3.0", "../evil", PAGE)).toThrow("invalid adapter name");
    expect(() => adapterUrl(DEFAULT_ENDPOINT, "0.3.0", "OneTrust", PAGE)).toThrow("invalid adapter name");
  });

  it("serves adapters only from the collection host or the page's own origin", () => {
    const evil = resolveEndpoint("https://evil.example", LOCATION);
    expect(eventsUrl(evil)).toBe("https://evil.example/v1/e");
    expect(() => adapterUrl(evil, "0.3.0", "x", PAGE)).toThrow(EndpointError);
    expect(() => adapterUrl(resolveEndpoint("https://t.example.com/amnda", LOCATION), "0.3.0", "x", PAGE)).toThrow(
      EndpointError,
    );
    expect(adapterUrl(resolveEndpoint("/amnda", DEV), "0.3.0", "x", DEV.origin)).toBe(
      "http://localhost:8080/amnda/adapters/0.3.0/x.js",
    );
  });
});

describe("REFERRER_POLICY", () => {
  it("sends the page's origin alone as Referer, never its path or query", () => {
    expect(REFERRER_POLICY).toBe("strict-origin");
  });
});

describe("configRequestInit", () => {
  it("sends no cookie, and the page's origin alone as Referer", () => {
    expect(configRequestInit()).toEqual({ credentials: "omit", referrerPolicy: "strict-origin" });
  });
});

describe("batchRequestInit", () => {
  const batch: WireBatch = { seq: 1, e: [EVENT] };
  const body = JSON.stringify(batch);
  const pings: WireBatch = { e: [PING] };
  const pingBody = JSON.stringify(pings);

  it("posts events with same-origin credentials, so a proxied response's Set-Cookie is stored", () => {
    expect(batchRequestInit(body, "events")).toEqual({
      method: "POST",
      body,
      credentials: "same-origin",
      referrerPolicy: "strict-origin",
    });
  });

  it("posts pings without credentials, so the site's cookies never go with them", () => {
    expect(batchRequestInit(pingBody, "pings")).toEqual({
      method: "POST",
      body: pingBody,
      credentials: "omit",
      referrerPolicy: "strict-origin",
    });
    expect(batchRequestInit(pingBody, "pings", true).credentials).toBe("omit");
  });

  it("leaves keepalive off an ordinary batch, so one over 64 KiB is still sent", () => {
    const body = "x".repeat(100 * 1024);
    const init = batchRequestInit(body, "events");
    expect(init.keepalive).toBeUndefined();
    expect(init.body).toBe(body);
  });

  it("sets keepalive on the pagehide flush", () => {
    expect(batchRequestInit(body, "events", true)).toEqual({
      method: "POST",
      body,
      credentials: "same-origin",
      referrerPolicy: "strict-origin",
      keepalive: true,
    });
  });

  it("takes a pagehide body up to the limit, counted in UTF-8 bytes", () => {
    expect(batchRequestInit("x".repeat(KEEPALIVE_BODY_LIMIT), "events", true).keepalive).toBe(true);
    expect(bodyBytes("é😀")).toBe(6);
    // 3 bytes per character in UTF-8, though only one UTF-16 unit each
    const wide = "€".repeat(Math.floor(KEEPALIVE_BODY_LIMIT / 3) + 1);
    expect(wide.length).toBeLessThan(KEEPALIVE_BODY_LIMIT);
    expect(() => batchRequestInit(wide, "events", true)).toThrow(BatchSizeError);
  });

  it("refuses a pagehide body over the limit, which fetch would reject", () => {
    expect(KEEPALIVE_BODY_LIMIT).toBeLessThan(64 * 1024);
    expect(() => batchRequestInit("x".repeat(KEEPALIVE_BODY_LIMIT + 1), "pings", true)).toThrow(BatchSizeError);
  });
});
