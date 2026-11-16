// Declined mode `off` end to end (AAI-86): the boot, the consent sources, the state machine and the
// transport wired together as a.js is to wire them (AAI-964), on a stand-in window that records
// every request and every touch of storage. A visitor who declined under `off` sends nothing: the
// only request is the anonymous, cookie-free config fetch, and no storage of any kind is touched.
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
import { fakeWindow, jsonResponse, scriptTag, type FakeResponse, type FakeWindow } from "./fake-window";

const CONFIG = { schema_version: 1, site: "site_123", config_version: 7, consent: { declined_mode: "off" } };
const CONFIG_URL = `${DEFAULT_ENDPOINT}/cfg/site_123.json`;
const SNIPPET = { src: "https://eu.serversider.com/a.js", "data-site": "site_123" };
const STORAGE = ["localStorage", "sessionStorage", "indexedDB", "caches"] as const;

/** Every touch of storage: the Web Storage, IndexedDB and Cache APIs, and cookie writes. */
let touched: string[];
let saved: (PropertyDescriptor | undefined)[];

beforeEach(() => {
  vi.useFakeTimers();
  touched = [];
  saved = STORAGE.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  for (const name of STORAGE) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get: () => {
        touched.push(name);
        return undefined;
      },
    });
  }
});

afterEach(() => {
  STORAGE.forEach((name, i) => {
    const descriptor = saved[i];
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  });
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The snippet's stub: it queues each call's arguments on amanda.q. */
function snippetStub(win: FakeWindow): AmandaFunction {
  const stub: AmandaFunction = function (...args: unknown[]) {
    (stub.q = stub.q || []).push(args);
  };
  win.amanda = stub;
  return stub;
}

/**
 * The page: a window whose config fetch answers with CONFIG and whose /v1/e answers with collector,
 * then 204s, and the tag booted on it with the consent machine feeding the transport.
 */
function page(collector: FakeResponse[] = []) {
  const queue = [...collector];
  const win = fakeWindow(scriptTag(SNIPPET), async () => jsonResponse(CONFIG));
  win.fetchMock.mockImplementation(async (url: string) =>
    url === CONFIG_URL ? jsonResponse(CONFIG) : (queue.shift() ?? jsonResponse(null, 204)),
  );
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
  for (const name of STORAGE) {
    Object.defineProperty(win, name, { get: () => (globalThis as Record<string, unknown>)[name] });
  }
  Object.defineProperty(win.document, "cookie", {
    get: () => "",
    set: (value: string) => touched.push(`cookie: ${value}`),
  });

  const reports: ErrorReport[] = [];
  const boundary = new ErrorBoundary((report) => reports.push(report), 1);
  const anonymous: PageviewInput[] = [];
  let machine: ConsentMachine<PageviewInput> | undefined;
  // The machine's pagehide goes before the transport's (consent.ts).
  win.addEventListener("pagehide" as "popstate", () => boundary.guard("consent", () => machine?.pagehide()));
  const transport = createTransport(win as unknown as Parameters<typeof createTransport>[0], DEFAULT_ENDPOINT, boundary);
  const booted = boot(win, {
    tagVersion: "0.2.0",
    boundary,
    onPageview: (input) => machine!.collect(input),
    consent: (config) => {
      machine = createConsent<PageviewInput>({
        declinedMode: declinedMode(config),
        sink: {
          identified: (input, consent) =>
            transport.event(
              buildEvent({
                ...input,
                visitor_id: "01934f6c-8d2a-7b3c-8d4e-5f6a7b8c9d01",
                session_id: "01934f6c-8d2a-7b3c-ad4e-5f6a7b8c9d02",
                consent,
              }),
            ),
          anonymous: (input) => anonymous.push(input),
          withdraw: () => transport.withdrawEvents(),
        },
        identity: { forget: () => undefined, renew: () => undefined },
      });
      return machine;
    },
  });

  return {
    win,
    booted,
    reports,
    anonymous,
    machine: () => machine!,
    /** The URLs fetched, in order. */
    requests: () => win.fetchMock.mock.calls.map((call) => call[0] as string),
    beacons: () => beacon.mock.calls.length,
    /** A route change, two pageviews' worth of browsing, then the page goes. */
    browseAndLeave: async () => {
      win.history.pushState(null, "", "/cart");
      win.back("/products?id=1");
      await vi.advanceTimersByTimeAsync(60_000);
      for (const listener of pagehide) listener();
      await vi.advanceTimersByTimeAsync(60_000);
    },
  };
}

describe("declined mode off: a visitor who declined sends nothing and stores nothing", () => {
  it("is the default for a site whose config sets no declined mode", () => {
    expect(declinedMode({ schema_version: 1, site: "site_123", config_version: 1 })).toBe("off");
  });

  it("denied by amanda('consent', ...) before the tag loads: only the config fetch, without cookies", async () => {
    const p = page();
    snippetStub(p.win)("consent", { analytics: "denied", ads: "denied" });
    await p.booted;
    await p.browseAndLeave();

    expect(p.machine().mode()).toBe("declined");
    expect(p.win.fetchMock.mock.calls).toEqual([[CONFIG_URL, configRequestInit()]]);
    expect(p.beacons()).toBe(0);
    expect(p.anonymous).toEqual([]);
    expect(touched).toEqual([]);
    expect(p.reports).toEqual([]);
  });

  it("denied by Google Consent Mode's default: only the config fetch", async () => {
    const p = page();
    p.win.dataLayer = [["consent", "default", { analytics_storage: "denied", ad_storage: "denied", ad_user_data: "denied" }]];
    await p.booted;
    await p.browseAndLeave();

    expect(p.requests()).toEqual([CONFIG_URL]);
    expect(p.beacons()).toBe(0);
    expect(p.anonymous).toEqual([]);
    expect(touched).toEqual([]);
    expect(p.reports).toEqual([]);
  });

  it("still unknown when the page goes: the pending pageviews are dropped", async () => {
    const p = page();
    await p.booted;
    expect(p.machine().pendingCount()).toBe(1);
    await p.browseAndLeave();

    expect(p.machine().pendingCount()).toBe(0);
    expect(p.requests()).toEqual([CONFIG_URL]);
    expect(p.beacons()).toBe(0);
    expect(touched).toEqual([]);
  });

  it("unknown, then denied: the pending pageviews are dropped, never sent", async () => {
    const p = page();
    await p.booted;
    (p.win.dataLayer as unknown[]).push(["consent", "update", { analytics_storage: "denied" }]);
    await p.browseAndLeave();

    expect(p.requests()).toEqual([CONFIG_URL]);
    expect(p.beacons()).toBe(0);
    expect(touched).toEqual([]);
  });

  it("granted, then denied: what was collected but not sent yet never goes, nor anything after", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // The first pageview's batch meets a 503 and awaits its retry when the visitor declines.
    const p = page([jsonResponse(null, 503)]);
    snippetStub(p.win)("consent", { analytics: "granted", ads: "granted" });
    await p.booted;
    await vi.advanceTimersByTimeAsync(0);
    expect(p.requests()).toEqual([CONFIG_URL, `${DEFAULT_ENDPOINT}/v1/e`]);

    p.win.amanda!("consent", { analytics: "denied", ads: "denied" });
    await p.browseAndLeave();

    expect(p.requests()).toEqual([CONFIG_URL, `${DEFAULT_ENDPOINT}/v1/e`]);
    expect(p.beacons()).toBe(0);
    expect(touched).toEqual([]);
    expect(p.reports).toEqual([]);
  });
});
