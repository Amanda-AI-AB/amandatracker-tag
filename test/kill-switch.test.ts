// The kill switch end to end (AAI-797): the site's config sets `paused` (AAI-92) and the tag sends
// nothing. The boot, the consent machine and the transport are wired as in declined-off.test.ts, on
// a stand-in window that records every request, with a visitor who granted everything: while the
// flag is set, the only request is the anonymous config fetch; once it is cleared, the tag collects.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boot } from "../src/core/boot";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import { declinedMode } from "../src/core/config";
import { createConsent, type ConsentMachine } from "../src/core/consent";
import { configRequestInit, DEFAULT_ENDPOINT } from "../src/core/endpoint";
import type { PageviewInput } from "../src/core/pageview";
import type { AmandaFunction } from "../src/core/queue";
import { createTransport } from "../src/core/transport";
import { buildEvent } from "../src/wire/payload";
import { fakeWindow, jsonResponse, scriptTag, type FakeWindow } from "./fake-window";

const CONFIG = { schema_version: 1, site: "site_123", config_version: 8, consent: { declined_mode: "pings" } };
const CONFIG_URL = `${DEFAULT_ENDPOINT}/cfg/site_123.json`;
const EVENTS_URL = `${DEFAULT_ENDPOINT}/v1/e`;
const SNIPPET = { src: "https://eu.serversider.com/a.js", "data-site": "site_123" };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The snippet's stub, with the visitor's consent already granted and an event queued. */
function snippetStub(win: FakeWindow): AmandaFunction {
  const stub: AmandaFunction = function (...args: unknown[]) {
    (stub.q = stub.q || []).push(args);
  };
  win.amanda = stub;
  stub("consent", { analytics: "granted", ads: "granted" });
  stub("pageview");
  return stub;
}

/** The page: a window whose config fetch answers with config, and the tag booted on it, wired as a.js is to. */
function page(config: Record<string, unknown>) {
  const win = fakeWindow(scriptTag(SNIPPET));
  win.fetchMock.mockImplementation(async (url: string) => (url === CONFIG_URL ? jsonResponse(config) : jsonResponse(null, 204)));
  const beacon = vi.fn(() => true);
  const pagehide: (() => void)[] = [];
  const addEventListener = win.addEventListener.bind(win);
  Object.assign(win, {
    navigator: { language: "sv-SE", sendBeacon: beacon },
    setTimeout: (handler: () => void, timeout: number) => setTimeout(handler, timeout),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    addEventListener: (type: string, listener: () => void) =>
      type === "pagehide" ? pagehide.push(listener) : addEventListener(type as "popstate", listener),
  });
  snippetStub(win);

  const reports: ErrorReport[] = [];
  const boundary = new ErrorBoundary((report) => reports.push(report), 1);
  const pageviews: PageviewInput[] = [];
  const anonymous: PageviewInput[] = [];
  const consent = vi.fn((siteConfig: Parameters<typeof declinedMode>[0]): ConsentMachine<PageviewInput> => {
    machine = createConsent<PageviewInput>({
      declinedMode: declinedMode(siteConfig),
      sink: {
        identified: (input, snapshot) =>
          transport.event(
            buildEvent({
              ...input,
              visitor_id: "01934f6c-8d2a-7b3c-8d4e-5f6a7b8c9d01",
              session_id: "01934f6c-8d2a-7b3c-ad4e-5f6a7b8c9d02",
              consent: snapshot,
            }),
          ),
        anonymous: (input) => anonymous.push(input),
        withdraw: () => transport.withdrawEvents(),
      },
      identity: { forget: () => undefined, renew: () => undefined },
    });
    return machine;
  });
  let machine: ConsentMachine<PageviewInput> | undefined;
  win.addEventListener("pagehide" as "popstate", () => boundary.guard("consent", () => machine?.pagehide()));
  const transport = createTransport(win as unknown as Parameters<typeof createTransport>[0], DEFAULT_ENDPOINT, boundary);
  const booted = boot(win, {
    tagVersion: "0.2.0",
    boundary,
    onPageview: (input) => {
      pageviews.push(input);
      machine!.collect(input);
    },
    consent,
  });

  return {
    win,
    booted,
    boundary,
    reports,
    pageviews,
    anonymous,
    consent,
    /** The URLs fetched, in order. */
    requests: () => win.fetchMock.mock.calls.map((call) => call[0] as string),
    beacons: () => beacon.mock.calls.length,
    /** The site calls the tag, the visitor browses, then the page goes. */
    browseAndLeave: async () => {
      win.amanda!("pageview");
      win.history.pushState(null, "", "/cart");
      win.back("/products?id=1");
      await vi.advanceTimersByTimeAsync(60_000);
      for (const listener of pagehide) listener();
      await vi.advanceTimersByTimeAsync(60_000);
    },
  };
}

describe("the kill switch: a paused site's tag sends nothing", () => {
  it("with the flag set: only the config fetch, without cookies, though the visitor granted everything", async () => {
    const p = page({ ...CONFIG, paused: true });

    expect(await p.booted).toBeUndefined();
    await p.browseAndLeave();

    expect(p.win.fetchMock.mock.calls).toEqual([[CONFIG_URL, configRequestInit()]]);
    expect(p.beacons()).toBe(0);
    expect(p.pageviews).toEqual([]);
    expect(p.anonymous).toEqual([]);
    // No consent source runs, so no consent manager's adapter is loaded either.
    expect(p.consent).not.toHaveBeenCalled();
    expect(p.reports).toEqual([]);
  });

  it("with the flag set: the site's calls stay on the stub, and never throw", async () => {
    const p = page({ ...CONFIG, paused: true });
    await p.booted;

    expect(() => p.win.amanda!("consent", { analytics: "denied", ads: "denied" })).not.toThrow();
    expect(p.win.amanda!.loaded).toBeUndefined();
    expect(p.win.amanda!.q).toHaveLength(3);
  });

  it("with the flag set: no tag error is sent from then on", async () => {
    const p = page({ ...CONFIG, paused: true });
    await p.booted;

    p.boundary.report("pageview", new Error("after the pause"));

    expect(p.reports).toEqual([]);
  });

  it("with the flag set: a build the config pins is not loaded", async () => {
    // The fake document can't load a script: a hand-off would fail, and this build would run instead.
    const p = page({ ...CONFIG, paused: true, bundle_version: "0.3.0" });

    expect(await p.booted).toBeUndefined();
    await p.browseAndLeave();

    expect(p.requests()).toEqual([CONFIG_URL]);
    expect(p.pageviews).toEqual([]);
  });

  for (const flag of [{ paused: false }, {}]) {
    it(`with the flag cleared (${JSON.stringify(flag)}): the tag collects normally`, async () => {
      const p = page({ ...CONFIG, ...flag });

      expect(await p.booted).toBeDefined();
      await p.browseAndLeave();

      expect(p.requests()[0]).toBe(CONFIG_URL);
      expect(p.requests()).toContain(EVENTS_URL);
      expect(p.requests().slice(1).every((url) => url === EVENTS_URL)).toBe(true);
      // The queued pageview, the landing, the amanda('pageview') call and two route changes.
      expect(p.pageviews).toHaveLength(5);
      expect(p.consent).toHaveBeenCalledTimes(1);
      expect(p.reports).toEqual([]);
    });
  }

  it("with a flag that isn't a boolean: the tag doesn't run, and reports why", async () => {
    const p = page({ ...CONFIG, paused: "yes" });

    expect(await p.booted).toBeUndefined();
    await p.browseAndLeave();

    expect(p.requests()).toEqual([CONFIG_URL]);
    expect(p.pageviews).toEqual([]);
    expect(p.reports).toEqual([{ stage: "config", name: "ConfigError", message: "the config's paused is not a boolean: yes" }]);
  });
});
