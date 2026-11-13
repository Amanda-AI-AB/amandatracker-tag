import { afterEach, describe, expect, it, vi } from "vitest";
import { boot, type TagWindow } from "../src/core/boot";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import { configRequestInit, DEFAULT_ENDPOINT } from "../src/core/endpoint";
import type { PageviewInput } from "../src/core/pageview";
import type { AmandaFunction } from "../src/core/queue";
import { buildEvent } from "../src/wire/payload";
import { fakeWindow, jsonResponse, PAGE, scriptTag, type FakeWindow } from "./fake-window";
import { validator } from "./wire-validator";

const CONFIG = { schema_version: 1, site: "site_123", config_version: 7, consent: { declined_mode: "pings" } };
const SNIPPET = { src: "https://eu.serversider.com/a.js", "data-site": "site_123" };

/** The snippet's stub: it queues each call's arguments on amanda.q. */
function snippetStub(win: TagWindow): AmandaFunction {
  const stub: AmandaFunction = function (...args: unknown[]) {
    (stub.q = stub.q || []).push(args);
  };
  win.amanda = stub;
  return stub;
}

function setup(win: FakeWindow, now = 1_731_400_000_000) {
  const reports: ErrorReport[] = [];
  const pageviews: PageviewInput[] = [];
  const boundary = new ErrorBoundary((report) => reports.push(report), 1);
  const booted = boot(win, { tagVersion: "0.2.0", boundary, onPageview: (p) => pageviews.push(p), now: () => now });
  return { reports, pageviews, booted };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("boot", () => {
  it("boots from a snippet install: reads the config without cookies and sends a pageview", async () => {
    const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(CONFIG));
    const { reports, pageviews, booted } = setup(win);

    const tag = await booted;

    expect(win.fetchMock).toHaveBeenCalledWith(`${DEFAULT_ENDPOINT}/cfg/site_123.json`, configRequestInit());
    expect(tag).toEqual({ endpoint: DEFAULT_ENDPOINT, site: "site_123", config: CONFIG });
    expect(pageviews).toEqual([
      {
        type: "pageview",
        site_id: "site_123",
        tag_version: "0.2.0",
        client_ts: 1_731_400_000_000,
        url: `${PAGE}/products?id=1`,
        referrer: "https://search.example/",
        page_title: "Products",
        language: "sv-SE",
      },
    ]);
    expect(reports).toEqual([]);
    expect(win.amanda!.loaded).toBe(true);
  });

  it("sends a pageview the wire schema accepts once the ids and consent are added", async () => {
    const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(CONFIG));
    const { pageviews, booted } = setup(win);
    await booted;

    const event = buildEvent({
      ...pageviews[0]!,
      visitor_id: "01934f6c-8d2a-7b3c-8d4e-5f6a7b8c9d01",
      session_id: "01934f6c-8d2a-7b3c-ad4e-5f6a7b8c9d02",
      consent: { analytics: "granted", ads: "granted" },
    });
    const validate = validator("event.json");
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
  });

  it("fetches the config from data-endpoint", async () => {
    const win = fakeWindow(scriptTag({ ...SNIPPET, "data-endpoint": "/amnda" }), jsonResponse(CONFIG));
    const { booted } = setup(win);

    expect((await booted)!.endpoint).toBe(`${PAGE}/amnda`);
    expect(win.fetchMock).toHaveBeenCalledWith(`${PAGE}/amnda/cfg/site_123.json`, configRequestInit());
  });

  it("runs the calls the snippet queued, in order, before the first pageview", async () => {
    const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(CONFIG));
    const stub = snippetStub(win);
    stub("pageview");
    stub("no-such-command", 1);
    const { reports, pageviews, booted } = setup(win);
    // made while the config loads: it still queues on the stub
    win.amanda!("pageview");
    expect(pageviews).toEqual([]);

    await booted;

    expect(pageviews).toHaveLength(3);
    expect(reports).toEqual([{ stage: "command", name: "CommandError", message: "unknown command: no-such-command" }]);
    expect(win.amanda).not.toBe(stub);
  });

  it("defines the queueing stub itself when the page has no snippet", async () => {
    let answer: (response: ReturnType<typeof jsonResponse>) => void = () => undefined;
    const win = fakeWindow(scriptTag(SNIPPET), () => new Promise((resolve) => (answer = resolve)));
    const { pageviews, booted } = setup(win);

    expect(typeof win.amanda).toBe("function");
    win.amanda!("pageview");
    expect(win.amanda!.q).toHaveLength(1);
    answer(jsonResponse(CONFIG));
    await booted;

    expect(pageviews).toHaveLength(2);
  });

  it("leaves a page alone where another copy of the tag already runs", async () => {
    const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(CONFIG));
    const running: AmandaFunction = () => undefined;
    running.loaded = true;
    win.amanda = running;
    const { reports, pageviews, booted } = setup(win);

    expect(await booted).toBeUndefined();
    expect(win.amanda).toBe(running);
    expect(win.fetchMock).not.toHaveBeenCalled();
    expect(pageviews).toEqual([]);
    expect(reports).toEqual([]);
  });

  describe("reports, and never throws, when it can't boot", () => {
    it("for a config the CDN doesn't have", async () => {
      const win = fakeWindow(scriptTag(SNIPPET), jsonResponse({ error: "not found" }, 404));
      const { reports, pageviews, booted } = setup(win);

      expect(await booted).toBeUndefined();
      expect(reports).toEqual([
        { stage: "config", name: "ConfigError", message: `GET ${DEFAULT_ENDPOINT}/cfg/site_123.json: HTTP 404` },
      ]);
      expect(pageviews).toEqual([]);
      expect(win.amanda!.loaded).toBeUndefined();
    });

    it("for a network failure", async () => {
      const win = fakeWindow(scriptTag(SNIPPET), () => Promise.reject(new TypeError("Failed to fetch")));
      const { reports, booted } = setup(win);

      expect(await booted).toBeUndefined();
      expect(reports).toEqual([{ stage: "config", name: "TypeError", message: "Failed to fetch" }]);
    });

    it("for another site's config", async () => {
      const win = fakeWindow(scriptTag(SNIPPET), jsonResponse({ ...CONFIG, site: "other" }));
      const { reports, pageviews, booted } = setup(win);

      expect(await booted).toBeUndefined();
      expect(reports[0]).toMatchObject({ stage: "config", name: "ConfigError" });
      expect(pageviews).toEqual([]);
    });

    it("for a snippet without data-site, before fetching anything", async () => {
      const win = fakeWindow(scriptTag({ src: SNIPPET.src }), jsonResponse(CONFIG));
      const { reports, booted } = setup(win);

      expect(await booted).toBeUndefined();
      expect(reports[0]).toMatchObject({ stage: "boot", name: "ConfigError" });
      expect(win.fetchMock).not.toHaveBeenCalled();
    });

    it("for a lost or clobbered currentScript", async () => {
      for (const script of [null, scriptTag(SNIPPET, "IMG")]) {
        const win = fakeWindow(script, jsonResponse(CONFIG));
        const { reports, booted } = setup(win);

        expect(await booted).toBeUndefined();
        expect(reports[0]).toMatchObject({ stage: "boot", name: "EndpointError" });
        expect(win.fetchMock).not.toHaveBeenCalled();
      }
    });
  });

  it("reports a throwing pageview sink and keeps running", async () => {
    const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(CONFIG));
    const reports: ErrorReport[] = [];
    const boundary = new ErrorBoundary((report) => reports.push(report), 1);
    const onPageview = vi.fn(() => {
      throw new Error("transport down");
    });

    const tag = await boot(win, { tagVersion: "0.2.0", boundary, onPageview });
    expect(tag).toBeDefined();
    expect(() => win.history.pushState(null, "", "/cart")).not.toThrow();
    expect(() => win.amanda!("pageview")).not.toThrow();

    expect(onPageview).toHaveBeenCalledTimes(3);
    expect(reports).toEqual(Array(3).fill({ stage: "pageview", name: "Error", message: "transport down" }));
  });
});

describe("pageviews on route changes", () => {
  async function booted() {
    const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(CONFIG));
    const result = setup(win);
    await result.booted;
    return { win, ...result };
  }

  it("sends one on pushState to another route, with the previous page as referrer", async () => {
    const { win, pageviews } = await booted();

    win.history.pushState({}, "", "/cart");

    expect(pageviews).toHaveLength(2);
    expect(pageviews[1]).toMatchObject({ url: `${PAGE}/cart`, referrer: `${PAGE}/products?id=1` });
  });

  it("sends one on replaceState to another route, and on popstate", async () => {
    const { win, pageviews } = await booted();

    win.history.replaceState({}, "", "/products?id=2");
    win.back(`${PAGE}/products?id=1`);

    expect(pageviews.map((p) => p.url)).toEqual([
      `${PAGE}/products?id=1`,
      `${PAGE}/products?id=2`,
      `${PAGE}/products?id=1`,
    ]);
    expect(pageviews[2]!.referrer).toBe(`${PAGE}/products?id=2`);
  });

  it("sends none when only the fragment or the state changes", async () => {
    const { win, pageviews } = await booted();

    win.history.pushState({}, "", "#reviews");
    win.history.replaceState({ scrolled: true }, "");
    win.back(`${PAGE}/products?id=1#top`);

    expect(pageviews).toHaveLength(1);
  });

  it("keeps the page's own history calls as they are: their result, their this and their errors", async () => {
    const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(CONFIG));
    const calls: unknown[] = [];
    win.history.pushState = function (this: History, ...args: unknown[]) {
      calls.push(this, args);
      if (args[2] === "/boom") throw new DOMException("SecurityError");
      return "page's result" as unknown as void;
    };
    const { pageviews, reports, booted: done } = setup(win);
    await done;

    expect(win.history.pushState(1, "", "/a")).toBe("page's result");
    expect(calls).toEqual([win.history, [1, "", "/a"]]);
    expect(() => win.history.pushState(1, "", "/boom")).toThrow("SecurityError");
    // The stand-in history didn't move location, so neither call is a route change.
    expect(pageviews).toHaveLength(1);
    expect(reports).toEqual([]);
  });
});
