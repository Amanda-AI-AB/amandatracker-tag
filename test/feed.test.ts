// The pageview feed end to end (AAI-964): the boot, the consent sources, the consent machine, the
// identity and the transport wired by createFeed as a.js wires them (src/core/index.ts), on a
// stand-in window whose cookies are a CookieJar. A granted visitor's pageview leaves as an event,
// a declined one's as a ping in declined mode `pings` and not at all in mode `off`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boot } from "../src/core/boot";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import { DEFAULT_ENDPOINT } from "../src/core/endpoint";
import { createFeed } from "../src/core/feed";
import { SESSION_COOKIE, VISITOR_COOKIE } from "../src/core/identity";
import type { AmandaFunction } from "../src/core/queue";
import { defaultTarget } from "../src/core/telemetry";
import { CookieJar } from "./cookie-jar";
import { fakeWindow, jsonResponse, PAGE, scriptTag, type FakeWindow } from "./fake-window";
import { validator } from "./wire-validator";

const CONFIG_URL = `${DEFAULT_ENDPOINT}/cfg/site_123.json`;
const EVENTS_URL = `${DEFAULT_ENDPOINT}/v1/e`;
const SNIPPET = { src: "https://eu.serversider.com/a.js", "data-site": "site_123" };
const LANDING = `${PAGE}/products?id=1&gclid=G1&utm_source=news`;
const validateBatch = validator("batch.json");

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
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
 * A page on LANDING whose config sets declinedMode (and any other consent settings), and the tag
 * booted on it as a.js boots it.
 */
function page(declinedMode: "off" | "pings", queued: unknown[][] = [], consent: Record<string, unknown> = {}) {
  const config = { schema_version: 1, site: "site_123", config_version: 7, consent: { declined_mode: declinedMode, ...consent } };
  const jar = new CookieJar("shop.example.com", () => Date.now());
  const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(null, 404), LANDING);
  win.fetchMock.mockImplementation(async (url: string) => (url === CONFIG_URL ? jsonResponse(config) : jsonResponse(null, 204)));
  const beacon = vi.fn(() => true);
  const pagehide: (() => void)[] = [];
  const addEventListener = win.addEventListener.bind(win);
  Object.assign(win, {
    navigator: { language: "sv-SE", sendBeacon: beacon },
    setTimeout: (handler: () => void, timeout: number) => setTimeout(handler, timeout),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    addEventListener: (type: string, listener: () => void) =>
      type === "pagehide" ? pagehide.push(listener) : addEventListener(type, listener),
  });
  Object.defineProperty(win.document, "cookie", {
    get: () => jar.cookie,
    set: (value: string) => {
      jar.cookie = value;
    },
  });
  const stub = snippetStub(win);
  for (const args of queued) stub(...args);

  const reports: ErrorReport[] = [];
  const boundary = new ErrorBoundary((report) => reports.push(report), 1);
  const target = defaultTarget();
  const feed = createFeed(win, boundary, target);
  const booted = boot(win, { tagVersion: "0.2.0", boundary, target, onPageview: feed.pageview, consent: feed.consent });

  const posts = () => (win.fetchMock.mock.calls as [string, RequestInit][]).filter(([url]) => url === EVENTS_URL);
  return {
    win,
    jar,
    booted,
    reports,
    /** The URLs fetched, in order. */
    requests: () => (win.fetchMock.mock.calls as [string][]).map(([url]) => url),
    /** The /v1/e bodies sent by fetch, parsed. */
    batches: () => posts().map(([, init]) => JSON.parse(init.body as string)),
    /** The bodies sent by sendBeacon, parsed. */
    beacons: () => (beacon.mock.calls as unknown as [string, string][]).map(([, body]) => JSON.parse(body)),
    leave: async () => {
      for (const listener of pagehide) listener();
      await vi.advanceTimersByTimeAsync(60_000);
    },
  };
}

describe("the pageview feed", () => {
  it("granted: boot, then a pageview, is one fetch to /v1/e with seq 1, an event with the ids and the consent snapshot", async () => {
    const p = page("off", [["consent", { analytics: "granted", ads: "granted" }]]);
    await p.booted;
    await vi.advanceTimersByTimeAsync(0);

    expect(p.requests()).toEqual([CONFIG_URL, EVENTS_URL]);
    const [batch] = p.batches();
    expect(validateBatch(batch), JSON.stringify(validateBatch.errors)).toBe(true);
    expect(batch.seq).toBe(1);
    expect(batch.e).toHaveLength(1);
    const [event] = batch.e;
    expect(event).toMatchObject({
      type: "pageview",
      site_id: "site_123",
      url: LANDING,
      consent: { analytics: "granted", ads: "granted", source: "manual" },
      attribution: { utm: { source: "news" }, click_ids: { gclid: "G1" } },
    });
    // The ids are the visitor's cookies, which the identity wrote under the grant.
    expect(p.jar.cookie).toContain(`${VISITOR_COOKIE}=v1.${event.visitor_id}`);
    expect(p.jar.cookie).toContain(`${SESSION_COOKIE}=v1.${event.session_id}.`);
    expect(p.reports).toEqual([]);
  });

  it("granted analytics under denied ads: the event goes without its click IDs", async () => {
    const p = page("off", [["consent", { analytics: "granted", ads: "denied" }]]);
    await p.booted;
    await vi.advanceTimersByTimeAsync(0);

    const [event] = p.batches()[0].e;
    expect(event.url).toBe(`${PAGE}/products?id=1&utm_source=news`);
    expect(event.attribution).toEqual({ utm: { source: "news" } });
    expect(event.consent).toEqual({ analytics: "granted", ads: "denied", source: "manual" });
    expect(p.reports).toEqual([]);
  });

  it("unknown, then granted: the pending pageview leaves as an event once consent comes", async () => {
    const p = page("off");
    await p.booted;
    await vi.advanceTimersByTimeAsync(0);
    expect(p.requests()).toEqual([CONFIG_URL]);

    p.win.amanda!("consent", { analytics: "granted", ads: "granted" });
    await vi.advanceTimersByTimeAsync(0);

    const batches = p.batches();
    expect(batches).toHaveLength(1);
    expect(batches[0].seq).toBe(1);
    expect(batches[0].e.map((e: { type: string }) => e.type)).toEqual(["pageview"]);
    expect(p.reports).toEqual([]);
  });

  it("declined in mode pings: each pageview goes as a ping, without seq and without cookies", async () => {
    const p = page("pings", [["consent", { analytics: "denied", ads: "denied" }]]);
    await p.booted;
    p.win.history.pushState(null, "", "/cart");
    await vi.advanceTimersByTimeAsync(60_000);

    const batches = p.batches();
    for (const batch of batches) {
      expect(validateBatch(batch), JSON.stringify(validateBatch.errors)).toBe(true);
      expect(batch.seq).toBeUndefined();
    }
    const pings = batches.flatMap((batch) => batch.e as Record<string, unknown>[]);
    expect(pings.map((ping) => [ping.type, ping.path])).toEqual([
      ["pageview", "/products"],
      ["pageview", "/cart"],
    ]);
    expect(pings.every((ping) => ping.visitor_id === undefined && ping.consent === undefined)).toBe(true);
    expect(p.jar.writes).toEqual([]);
    expect(p.reports).toEqual([]);
  });

  it("declined in mode pings, by default: the ping carries no click ID", async () => {
    const p = page("pings", [["consent", { analytics: "denied", ads: "denied" }]]);
    await p.booted;
    await vi.advanceTimersByTimeAsync(60_000);

    const [ping] = p.batches()[0].e;
    expect(ping).toMatchObject({ path: "/products", utm: { source: "news" } });
    expect(ping).not.toHaveProperty("click_ids");
    expect(JSON.stringify(ping)).not.toContain("G1");
    expect(p.reports).toEqual([]);
  });

  it("declined in mode pings, with pings_include_click_ids on: the ping carries the page's click IDs", async () => {
    const p = page("pings", [["consent", { analytics: "denied", ads: "denied" }]], { pings_include_click_ids: true });
    await p.booted;
    await vi.advanceTimersByTimeAsync(60_000);

    const [batch] = p.batches();
    expect(validateBatch(batch), JSON.stringify(validateBatch.errors)).toBe(true);
    expect(batch.e[0]).toMatchObject({ path: "/products", utm: { source: "news" }, click_ids: { gclid: "G1" } });
    expect(batch.e[0].visitor_id).toBeUndefined();
    expect(p.jar.writes).toEqual([]);
    expect(p.reports).toEqual([]);
  });

  it("still unknown in mode pings when the page goes: the pending pageview leaves as a ping in the pagehide flush", async () => {
    const p = page("pings");
    await p.booted;
    await p.leave();

    const pings = [...p.batches(), ...p.beacons()].flatMap((batch) => batch.e as Record<string, unknown>[]);
    expect(pings.map((ping) => ping.type)).toEqual(["pageview"]);
    expect(p.jar.writes).toEqual([]);
    expect(p.reports).toEqual([]);
  });

  it("declined in mode off: nothing goes but the config fetch", async () => {
    const p = page("off", [["consent", { analytics: "denied", ads: "denied" }]]);
    await p.booted;
    p.win.history.pushState(null, "", "/cart");
    await p.leave();

    expect(p.requests()).toEqual([CONFIG_URL]);
    expect(p.beacons()).toEqual([]);
    expect(p.jar.writes).toEqual([]);
    expect(p.reports).toEqual([]);
  });
});
