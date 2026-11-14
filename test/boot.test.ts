import { afterEach, describe, expect, it, vi } from "vitest";
import { boot, type TagWindow } from "../src/core/boot";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import { createConsent, type Consent } from "../src/core/consent";
import { configRequestInit, DEFAULT_ENDPOINT } from "../src/core/endpoint";
import type { PageviewInput } from "../src/core/pageview";
import type { AmandaFunction } from "../src/core/queue";
import { defaultTarget } from "../src/core/telemetry";
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

  it("fills in the tag errors' target as it resolves the endpoint and the site", async () => {
    const win = fakeWindow(scriptTag({ ...SNIPPET, "data-endpoint": "/amnda" }), jsonResponse(CONFIG));
    const target = defaultTarget();
    const boundary = new ErrorBoundary(() => undefined, 1);

    await boot(win, { tagVersion: "0.2.0", boundary, target, onPageview: () => undefined });

    expect(target).toEqual({ endpoint: `${PAGE}/amnda`, site: "site_123" });
  });

  it("keeps the default target when data-endpoint is refused, and has no site without data-site", async () => {
    const refused = fakeWindow(scriptTag({ ...SNIPPET, "data-endpoint": "javascript:alert(1)" }));
    const noSite = fakeWindow(scriptTag({ src: SNIPPET.src, "data-endpoint": "/amnda" }));
    const targets = [defaultTarget(), defaultTarget()];

    await boot(refused, { tagVersion: "0.2.0", boundary: new ErrorBoundary(() => undefined, 1), target: targets[0]!, onPageview: () => undefined });
    await boot(noSite, { tagVersion: "0.2.0", boundary: new ErrorBoundary(() => undefined, 1), target: targets[1]!, onPageview: () => undefined });

    expect(targets).toEqual([{ endpoint: DEFAULT_ENDPOINT }, { endpoint: `${PAGE}/amnda` }]);
  });

  it("samples the failures after the config by the config's error_sample_rate", async () => {
    const config = { ...CONFIG, telemetry: { error_sample_rate: 0 } };
    const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(config));
    const reports: ErrorReport[] = [];
    const boundary = new ErrorBoundary((report) => reports.push(report), 1);

    await boot(win, { tagVersion: "0.2.0", boundary, onPageview: () => undefined });
    win.amanda!("no-such-command");

    expect(reports).toEqual([]);
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

describe("the consent sources", () => {
  function bootWithConsent(win: FakeWindow) {
    const reports: ErrorReport[] = [];
    const boundary = new ErrorBoundary((report) => reports.push(report), 1);
    const configs: unknown[] = [];
    const machine = createConsent<PageviewInput>({
      declinedMode: "off",
      sink: { identified: () => undefined, anonymous: () => undefined, withdraw: () => undefined },
      identity: { forget: () => undefined, renew: () => undefined },
    });
    const snapshots: Consent[] = [];
    const booted = boot(win, {
      tagVersion: "0.2.0",
      boundary,
      onPageview: () => snapshots.push(machine.snapshot()),
      consent: (config) => {
        configs.push(config);
        return machine;
      },
    });
    return { reports, machine, snapshots, configs, booted };
  }

  it("hands the booted site's config to the consent option", async () => {
    const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(CONFIG));
    const { configs, booted } = bootWithConsent(win);
    await booted;
    expect(configs).toEqual([CONFIG]);
  });

  it("applies a queued amanda('consent', ...) before the first pageview, naming the manual source", async () => {
    const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(CONFIG));
    snippetStub(win)("consent", { analytics: "granted", ads: "denied" });
    const { snapshots, reports, booted } = bootWithConsent(win);
    await booted;

    expect(snapshots).toEqual([{ analytics: "granted", ads: "denied", source: "manual" }]);
    expect(reports).toEqual([]);
  });

  it("reads Consent Mode's state before the first pageview, and follows its updates after", async () => {
    const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(CONFIG));
    win.dataLayer = [["consent", "default", { analytics_storage: "denied", ad_storage: "denied", ad_user_data: "denied" }]];
    const { snapshots, machine, booted } = bootWithConsent(win);
    await booted;
    expect(snapshots).toEqual([{ analytics: "denied", ads: "denied", source: "gcm" }]);

    (win.dataLayer as unknown[]).push(["consent", "update", { analytics_storage: "granted" }]);
    expect(machine.snapshot()).toEqual({ analytics: "granted", ads: "denied", source: "gcm" });
  });

  it("lets the manual API win over Consent Mode, before and after boot", async () => {
    const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(CONFIG));
    win.dataLayer = [["consent", "default", { analytics_storage: "granted" }]];
    snippetStub(win)("consent", { analytics: "denied" });
    const { snapshots, machine, booted } = bootWithConsent(win);
    await booted;
    expect(snapshots).toEqual([{ analytics: "denied", ads: "unknown", source: "manual" }]);

    (win.dataLayer as unknown[]).push(["consent", "update", { analytics_storage: "granted" }]);
    win.amanda!("consent", { ads: "granted" });
    expect(machine.snapshot()).toEqual({ analytics: "denied", ads: "granted", source: "manual" });
  });

  it("reports a refused amanda('consent', ...) and a dataLayer it can't follow, and still boots", async () => {
    const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(CONFIG));
    win.dataLayer = { not: "an array" };
    snippetStub(win)("consent", { analytics: "yes" });
    const { snapshots, reports, booted } = bootWithConsent(win);
    await booted;

    expect(snapshots).toEqual([{ analytics: "unknown", ads: "unknown" }]);
    expect(reports).toEqual([
      { stage: "consent", name: "ConsentError", message: "window.dataLayer is not an array; Consent Mode is not followed" },
      { stage: "command", name: "ConsentError", message: "consent analytics is granted or denied, not yes" },
    ]);
  });

  describe("Global Privacy Control", () => {
    const sendGpc = (win: FakeWindow): void => {
      (win.navigator as { globalPrivacyControl?: boolean }).globalPrivacyControl = true;
    };

    it("is a decline under the site's declined mode, before the first pageview, overruling a grant", async () => {
      const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(CONFIG));
      sendGpc(win);
      win.dataLayer = [["consent", "default", { analytics_storage: "granted", ad_storage: "granted", ad_user_data: "granted" }]];
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      snippetStub(win)("consent", { analytics: "granted", ads: "granted" });
      const { snapshots, machine, reports, booted } = bootWithConsent(win);
      await booted;

      expect(snapshots).toEqual([{ analytics: "denied", ads: "denied", source: "gpc" }]);
      expect(machine.mode()).toBe("declined");
      (win.dataLayer as unknown[]).push(["consent", "update", { analytics_storage: "granted" }]);
      win.amanda!("consent", { analytics: "granted" });
      expect(machine.snapshot()).toEqual({ analytics: "denied", ads: "denied", source: "gpc" });
      expect(warn).toHaveBeenCalledTimes(2);
      expect(reports).toEqual([]);
      warn.mockRestore();
    });

    it("is ignored where the site turns gpc_honored off", async () => {
      const win = fakeWindow(scriptTag(SNIPPET), jsonResponse({ ...CONFIG, consent: { ...CONFIG.consent, gpc_honored: false } }));
      sendGpc(win);
      snippetStub(win)("consent", { analytics: "granted", ads: "granted" });
      const { snapshots, booted } = bootWithConsent(win);
      await booted;

      expect(snapshots).toEqual([{ analytics: "granted", ads: "granted", source: "manual" }]);
    });

    it("changes nothing for a browser that doesn't send it", async () => {
      const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(CONFIG));
      const { snapshots, booted } = bootWithConsent(win);
      await booted;

      expect(snapshots).toEqual([{ analytics: "unknown", ads: "unknown" }]);
    });
  });

  it("follows no consent source without the consent option", async () => {
    const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(CONFIG));
    snippetStub(win)("consent", { analytics: "granted" });
    const { reports, booted } = setup(win);
    await booted;

    expect(win.dataLayer).toBeUndefined();
    expect(reports).toEqual([{ stage: "command", name: "CommandError", message: "unknown command: consent" }]);
  });
});
