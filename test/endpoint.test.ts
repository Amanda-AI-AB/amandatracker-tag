import { describe, expect, it } from "vitest";
import { adapterUrl } from "../src/core/adapter-loader";
import {
  BatchSizeError,
  DEFAULT_ENDPOINT,
  EndpointError,
  KEEPALIVE_BODY_LIMIT,
  batchRequestInit,
  bodyBytes,
  configUrl,
  endpointFromScript,
  eventsUrl,
  resolveEndpoint,
} from "../src/core/endpoint";

const PAGE = "https://shop.example.com";

describe("resolveEndpoint", () => {
  it("defaults to the collection host", () => {
    expect(DEFAULT_ENDPOINT).toBe("https://eu.serversider.com");
    expect(resolveEndpoint(null, PAGE)).toBe(DEFAULT_ENDPOINT);
    expect(resolveEndpoint(undefined, PAGE)).toBe(DEFAULT_ENDPOINT);
    expect(resolveEndpoint("  ", PAGE)).toBe(DEFAULT_ENDPOINT);
  });

  it("resolves a path against the page's own origin", () => {
    expect(resolveEndpoint("/amnda", PAGE)).toBe("https://shop.example.com/amnda");
    expect(resolveEndpoint("/amnda/", PAGE)).toBe("https://shop.example.com/amnda");
    expect(resolveEndpoint("amnda", PAGE)).toBe("https://shop.example.com/amnda");
  });

  it("accepts any https: endpoint", () => {
    expect(resolveEndpoint("https://t.example.com/amnda/", PAGE)).toBe("https://t.example.com/amnda");
    expect(resolveEndpoint("https://eu.serversider.com", PAGE)).toBe(DEFAULT_ENDPOINT);
  });

  it("accepts http: only on the page's own origin", () => {
    expect(resolveEndpoint("/amnda", "http://localhost:8080")).toBe("http://localhost:8080/amnda");
    expect(resolveEndpoint("http://localhost:8080/amnda", "http://localhost:8080")).toBe(
      "http://localhost:8080/amnda",
    );
    expect(() => resolveEndpoint("http://other.example.com/amnda", "http://localhost:8080")).toThrow(
      EndpointError,
    );
  });

  it("rejects other schemes", () => {
    for (const value of ["http://shop.example.com/amnda", "javascript:alert(1)", "data:text/plain,x"]) {
      expect(() => resolveEndpoint(value, PAGE)).toThrow(EndpointError);
    }
  });

  it("gives a scheme-relative value the page's scheme", () => {
    expect(resolveEndpoint("//t.example.com/amnda", PAGE)).toBe("https://t.example.com/amnda");
    expect(() => resolveEndpoint("//t.example.com/amnda", "http://localhost:8080")).toThrow(EndpointError);
  });

  it("rejects credentials, a query or a fragment", () => {
    expect(() => resolveEndpoint("https://u:p@t.example.com", PAGE)).toThrow(EndpointError);
    expect(() => resolveEndpoint("/amnda?x=1", PAGE)).toThrow(EndpointError);
    expect(() => resolveEndpoint("/amnda#x", PAGE)).toThrow(EndpointError);
  });

  it("rejects a value that is not a URL", () => {
    expect(() => resolveEndpoint("https://", PAGE)).toThrow(EndpointError);
  });
});

describe("endpointFromScript", () => {
  const script = (value: string | null) =>
    ({ getAttribute: (name: string) => (name === "data-endpoint" ? value : null) }) as unknown as Element;

  it("reads data-endpoint from the installing script tag", () => {
    expect(endpointFromScript(script("/amnda"), PAGE)).toBe("https://shop.example.com/amnda");
  });

  it("defaults without the attribute or without a script", () => {
    expect(endpointFromScript(script(null), PAGE)).toBe(DEFAULT_ENDPOINT);
    expect(endpointFromScript(null, PAGE)).toBe(DEFAULT_ENDPOINT);
  });
});

describe("the endpoint's URLs", () => {
  const endpoint = resolveEndpoint("/amnda", PAGE);

  it("serves config, events and adapters from the proxy", () => {
    expect(configUrl(endpoint, "SITE_1")).toBe("https://shop.example.com/amnda/cfg/SITE_1.json");
    expect(eventsUrl(endpoint)).toBe("https://shop.example.com/amnda/v1/e");
    expect(adapterUrl(endpoint, "example-cmp")).toBe("https://shop.example.com/amnda/adapters/example-cmp.js");
  });

  it("serves them from the collection host by default", () => {
    expect(configUrl(DEFAULT_ENDPOINT, "SITE_1")).toBe("https://eu.serversider.com/cfg/SITE_1.json");
    expect(eventsUrl(DEFAULT_ENDPOINT)).toBe("https://eu.serversider.com/v1/e");
  });

  it("escapes the site id in the config path", () => {
    expect(configUrl(endpoint, "a/../b")).toBe("https://shop.example.com/amnda/cfg/a%2F..%2Fb.json");
  });
});

describe("batchRequestInit", () => {
  it("posts with same-origin credentials, so a proxied response's Set-Cookie is stored", () => {
    expect(batchRequestInit('{"e":[]}')).toEqual({
      method: "POST",
      body: '{"e":[]}',
      credentials: "same-origin",
    });
  });

  it("leaves keepalive off an ordinary batch, so one over 64 KiB is still sent", () => {
    const body = "x".repeat(100 * 1024);
    const init = batchRequestInit(body);
    expect(init.keepalive).toBeUndefined();
    expect(init.body).toBe(body);
  });

  it("sets keepalive on the pagehide flush", () => {
    expect(batchRequestInit('{"e":[]}', true)).toEqual({
      method: "POST",
      body: '{"e":[]}',
      credentials: "same-origin",
      keepalive: true,
    });
  });

  it("takes a pagehide body up to the limit, counted in UTF-8 bytes", () => {
    expect(batchRequestInit("x".repeat(KEEPALIVE_BODY_LIMIT), true).keepalive).toBe(true);
    expect(bodyBytes("é😀")).toBe(6);
    // 3 bytes per character in UTF-8, though only one UTF-16 unit each
    const wide = "€".repeat(Math.floor(KEEPALIVE_BODY_LIMIT / 3) + 1);
    expect(wide.length).toBeLessThan(KEEPALIVE_BODY_LIMIT);
    expect(() => batchRequestInit(wide, true)).toThrow(BatchSizeError);
  });

  it("refuses a pagehide body over the limit, which fetch would reject", () => {
    expect(KEEPALIVE_BODY_LIMIT).toBeLessThan(64 * 1024);
    expect(() => batchRequestInit("x".repeat(KEEPALIVE_BODY_LIMIT + 1), true)).toThrow(BatchSizeError);
  });
});
