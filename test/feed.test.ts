// The pageview feed end to end (AAI-964): the boot, the consent sources, the consent machine, the
// identity and the transport wired by createFeed as a.js wires them (src/core/index.ts), on a
// stand-in window whose cookies are a CookieJar. A granted visitor's pageview leaves as an event,
// a declined one's as a ping in declined mode `pings` and not at all in mode `off`. The consent
// sources drive the machine (AAI-965): the `consent` command and Consent Mode's dataLayer commands,
// whose updates mid-session change the next event's snapshot. A page_exit (AAI-968) leaves by
// beacon as an event for a granted visitor, and never for a declined one, not even as a ping. So
// does a custom event (AAI-979), which goes in the next batch rather than by beacon.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boot } from "../src/core/boot";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import { DEFAULT_ENDPOINT } from "../src/core/endpoint";
import { createFeed } from "../src/core/feed";
import { readCookie, SESSION_COOKIE, VISITOR_COOKIE } from "../src/core/identity";
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

/** A gtag('consent', ...) call as gtag.js pushes it to the dataLayer: its arguments object. */
function gtag(..._args: unknown[]): IArguments {
  return arguments;
}

/**
 * A page on LANDING whose config sets declinedMode (and any other consent settings), and whose
 * dataLayer starts as layer, if given, and the tag booted on it as a.js boots it.
 */
function page(declinedMode: "off" | "pings", queued: unknown[][] = [], consent: Record<string, unknown> = {}, layer?: unknown[]) {
  const config = { schema_version: 1, site: "site_123", config_version: 7, consent: { declined_mode: declinedMode, ...consent } };
  const jar = new CookieJar("shop.example.com", () => Date.now());
  const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(null, 404), LANDING);
  if (layer !== undefined) win.dataLayer = layer;
  win.fetchMock.mockImplementation(async (url: string) => (url === CONFIG_URL ? jsonResponse(config) : jsonResponse(null, 204)));
  const beacon = vi.fn(() => true);
  const pagehide: (() => void)[] = [];
  const addEventListener = win.addEventListener.bind(win);
  // The engagement watcher's document: visible until the test hides it.
  let visibility: DocumentVisibilityState = "visible";
  const visibilityChange: (() => void)[] = [];
  Object.defineProperty(win.document, "visibilityState", { get: () => visibility });
  Object.assign(win.document, {
    addEventListener: (type: string, listener: () => void) => {
      if (type === "visibilitychange") visibilityChange.push(listener);
    },
  });
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
  const feed = createFeed(win, boundary, target, "0.2.0");
  const booted = boot(win, {
    tagVersion: "0.2.0",
    boundary,
    target,
    onPageview: feed.pageview,
    onPageExit: feed.pageExit,
    onEvent: feed.event,
    consent: feed.consent,
  });

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
    /** Hides the tab, as switching to another one does. */
    hide: async () => {
      visibility = "hidden";
      for (const listener of visibilityChange) listener();
      await vi.advanceTimersByTimeAsync(0);
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

  it("Consent Mode: the default grants, and an update mid-session changes the next event's snapshot", async () => {
    const granted = { analytics_storage: "granted", ad_storage: "granted", ad_user_data: "granted" };
    const p = page("off", [], {}, [gtag("consent", "default", granted)]);
    await p.booted;
    await vi.advanceTimersByTimeAsync(0);

    (p.win.dataLayer as unknown[]).push(gtag("consent", "update", { ad_user_data: "denied" }));
    p.win.history.pushState(null, "", "/cart");
    await vi.advanceTimersByTimeAsync(60_000);

    const batches = p.batches();
    for (const batch of batches) expect(validateBatch(batch), JSON.stringify(validateBatch.errors)).toBe(true);
    const events = batches.flatMap((batch) => batch.e as Record<string, unknown>[]);
    expect(events.map((event) => [new URL(event.url as string).pathname, event.consent])).toEqual([
      ["/products", { analytics: "granted", ads: "granted", source: "gcm" }],
      ["/cart", { analytics: "granted", ads: "denied", source: "gcm" }],
    ]);
    expect(p.reports).toEqual([]);
  });

  it("manual first: a later Consent Mode update doesn't override the site's own consent call", async () => {
    const p = page("off", [["consent", { analytics: "granted", ads: "granted" }]]);
    await p.booted;
    await vi.advanceTimersByTimeAsync(0);

    (p.win.dataLayer as unknown[]).push(gtag("consent", "update", { analytics_storage: "denied", ad_storage: "denied" }));
    p.win.history.pushState(null, "", "/cart");
    await vi.advanceTimersByTimeAsync(60_000);

    const events = p.batches().flatMap((batch) => batch.e as Record<string, unknown>[]);
    expect(events.map((event) => event.consent)).toEqual([
      { analytics: "granted", ads: "granted", source: "manual" },
      { analytics: "granted", ads: "granted", source: "manual" },
    ]);
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

describe("the page_exit feed (AAI-968)", () => {
  /** Every item sent, by fetch and by beacon, in the order of the two lists. */
  const sent = (p: ReturnType<typeof page>): Record<string, unknown>[] =>
    [...p.batches(), ...p.beacons()].flatMap((batch) => batch.e as Record<string, unknown>[]);

  it("granted: the page's hide sends a beacon batch with the page_exit, an event with the pageview's ids", async () => {
    const p = page("off", [["consent", { analytics: "granted", ads: "granted" }]]);
    await p.booted;
    await vi.advanceTimersByTimeAsync(5_000);
    await p.leave();

    const beacons = p.beacons();
    expect(beacons).toHaveLength(1);
    expect(validateBatch(beacons[0]), JSON.stringify(validateBatch.errors)).toBe(true);
    expect(beacons[0].seq).toBe(2);
    const [exit] = beacons[0].e;
    const [view] = p.batches()[0].e;
    expect(exit).toMatchObject({
      type: "page_exit",
      site_id: "site_123",
      url: LANDING,
      engagement_ms: 5_000,
      visitor_id: view.visitor_id,
      session_id: view.session_id,
      consent: { analytics: "granted", ads: "granted", source: "manual" },
    });
    expect(p.reports).toEqual([]);
  });

  it("granted: a hidden tab sends the page_exit by beacon at once, without waiting for pagehide", async () => {
    const p = page("off", [["consent", { analytics: "granted", ads: "granted" }]]);
    await p.booted;
    await vi.advanceTimersByTimeAsync(3_000);
    await p.hide();

    const exits = p.beacons().flatMap((batch) => batch.e as Record<string, unknown>[]);
    expect(exits.map((event) => [event.type, event.engagement_ms])).toEqual([["page_exit", 3_000]]);
    expect(p.reports).toEqual([]);
  });

  it("granted analytics under denied ads: the page_exit's url goes without its click IDs", async () => {
    const p = page("off", [["consent", { analytics: "granted", ads: "denied" }]]);
    await p.booted;
    await p.leave();

    const [exit] = p.beacons()[0].e;
    expect(exit.type).toBe("page_exit");
    expect(exit.url).toBe(`${PAGE}/products?id=1&utm_source=news`);
    expect(p.reports).toEqual([]);
  });

  it("declined in mode pings: the hide sends no page_exit, not even as a ping", async () => {
    const p = page("pings", [["consent", { analytics: "denied", ads: "denied" }]]);
    await p.booted;
    await vi.advanceTimersByTimeAsync(5_000);
    await p.hide();
    await p.leave();

    const items = sent(p);
    expect(items.map((item) => item.type)).toEqual(["pageview"]);
    expect(JSON.stringify(items)).not.toContain("engagement_ms");
    expect(p.jar.writes).toEqual([]);
    expect(p.reports).toEqual([]);
  });

  it("declined in mode off: the hide sends nothing, and nothing goes but the config fetch", async () => {
    const p = page("off", [["consent", { analytics: "denied", ads: "denied" }]]);
    await p.booted;
    await vi.advanceTimersByTimeAsync(5_000);
    await p.hide();
    await p.leave();

    expect(p.requests()).toEqual([CONFIG_URL]);
    expect(p.beacons()).toEqual([]);
    expect(p.jar.writes).toEqual([]);
    expect(p.reports).toEqual([]);
  });

  it("still unknown when the page goes, in mode pings: the pending page_exit is dropped, the pageview leaves as a ping", async () => {
    const p = page("pings");
    await p.booted;
    await vi.advanceTimersByTimeAsync(5_000);
    await p.leave();

    expect(sent(p).map((item) => item.type)).toEqual(["pageview"]);
    expect(p.jar.writes).toEqual([]);
    expect(p.reports).toEqual([]);
  });

  it("unknown while the tab is hidden, then granted: the pending page_exit leaves as an event", async () => {
    const p = page("off");
    await p.booted;
    await vi.advanceTimersByTimeAsync(4_000);
    await p.hide();
    expect(p.requests()).toEqual([CONFIG_URL]);
    expect(p.beacons()).toEqual([]);

    p.win.amanda!("consent", { analytics: "granted", ads: "granted" });
    await vi.advanceTimersByTimeAsync(0);

    const items = sent(p);
    expect(items.map((item) => [item.type, item.engagement_ms])).toEqual([
      ["pageview", undefined],
      ["page_exit", 4_000],
    ]);
    const [view, exit] = items;
    expect(exit!.visitor_id).toBe(view!.visitor_id);
    expect(exit!.consent).toEqual({ analytics: "granted", ads: "granted", source: "manual" });
    expect(p.reports).toEqual([]);
  });
});

describe("the custom event feed (AAI-979)", () => {
  /** Every item sent, by fetch and by beacon, in the order of the two lists. */
  const sent = (p: ReturnType<typeof page>): Record<string, unknown>[] =>
    [...p.batches(), ...p.beacons()].flatMap((batch) => batch.e as Record<string, unknown>[]);

  it("granted: amanda('event', 'signup', {plan: 'pro'}) leaves as an event valid against the schema, with the pageview's ids", async () => {
    const p = page("off", [["consent", { analytics: "granted", ads: "granted" }]]);
    await p.booted;
    p.win.amanda!("event", "signup", { plan: "pro" });
    await vi.advanceTimersByTimeAsync(60_000);

    const batches = p.batches();
    for (const batch of batches) expect(validateBatch(batch), JSON.stringify(validateBatch.errors)).toBe(true);
    const [view, signup] = batches.flatMap((batch) => batch.e as Record<string, unknown>[]);
    expect(signup).toMatchObject({
      type: "signup",
      props: { plan: "pro" },
      site_id: "site_123",
      url: LANDING,
      visitor_id: view!.visitor_id,
      session_id: view!.session_id,
      consent: { analytics: "granted", ads: "granted", source: "manual" },
    });
    expect(signup).not.toHaveProperty("attribution");
    expect(p.reports).toEqual([]);
  });

  it("unknown, then granted: the pending custom event leaves as an event once consent comes", async () => {
    const p = page("off");
    await p.booted;
    p.win.amanda!("event", "signup");
    await vi.advanceTimersByTimeAsync(0);
    expect(p.requests()).toEqual([CONFIG_URL]);

    p.win.amanda!("consent", { analytics: "granted", ads: "granted" });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sent(p).map((item) => item.type)).toEqual(["pageview", "signup"]);
    expect(p.reports).toEqual([]);
  });

  it("declined in mode pings: the custom event sends nothing, not even as a ping", async () => {
    const p = page("pings", [["consent", { analytics: "denied", ads: "denied" }]]);
    await p.booted;
    p.win.amanda!("event", "signup", { plan: "pro" });
    await p.leave();

    const items = sent(p);
    expect(items.map((item) => item.type)).toEqual(["pageview"]);
    expect(JSON.stringify(items)).not.toMatch(/signup|plan/);
    expect(p.jar.writes).toEqual([]);
    expect(p.reports).toEqual([]);
  });

  it("still unknown in mode pings when the page goes: the pending custom event is dropped", async () => {
    const p = page("pings");
    await p.booted;
    p.win.amanda!("event", "signup");
    await p.leave();

    expect(sent(p).map((item) => item.type)).toEqual(["pageview"]);
    expect(p.reports).toEqual([]);
  });

  it("declined in mode off: nothing goes but the config fetch", async () => {
    const p = page("off", [["consent", { analytics: "denied", ads: "denied" }]]);
    await p.booted;
    p.win.amanda!("event", "signup", { plan: "pro" });
    await p.leave();

    expect(p.requests()).toEqual([CONFIG_URL]);
    expect(p.beacons()).toEqual([]);
    expect(p.reports).toEqual([]);
  });

  it("granted: refused props are reported and nothing of the call is sent", async () => {
    const p = page("off", [["consent", { analytics: "granted", ads: "granted" }]]);
    await p.booted;
    p.win.amanda!("event", "signup", { user: { plan: "pro" } });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sent(p).map((item) => item.type)).toEqual(["pageview"]);
    expect(p.reports).toEqual([
      { stage: "command", name: "CommandError", message: "amanda('event', name, props) refuses props.user: not a string, a finite number or a boolean" },
    ]);
  });
});

describe("purge on withdrawal (AAI-785)", () => {
  const WITHDRAWAL_URL = `${DEFAULT_ENDPOINT}/v1/w`;
  const validateWithdrawal = validator("withdrawal.json");

  /**
   * A granted visitor's page whose config sets purge_on_withdrawal to purge, if given; each POST
   * /v1/w is recorded with the cookies live as it is sent.
   */
  async function grantedPage(declinedMode: "off" | "pings", purge?: boolean) {
    const p = page(declinedMode, [["consent", { analytics: "granted", ads: "granted" }]], purge === undefined ? {} : { purge_on_withdrawal: purge });
    await p.booted;
    await vi.advanceTimersByTimeAsync(0);
    const withdrawals: { body: Record<string, unknown>; init: RequestInit; cookies: string[] }[] = [];
    const answer = p.win.fetchMock.getMockImplementation()!;
    p.win.fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url === WITHDRAWAL_URL) {
        withdrawals.push({ body: JSON.parse(init.body as string), init, cookies: p.jar.live().map((c) => c.name) });
      }
      return answer(url, init);
    });
    const visitorId = p.batches()[0].e[0].visitor_id as string;
    return { ...p, withdrawals, visitorId };
  }

  it("on: a withdrawal posts the signal with the visitor id while the cookies are there, then deletes them", async () => {
    const p = await grantedPage("off", true);
    expect(p.jar.live().map((c) => c.name)).toEqual([VISITOR_COOKIE, SESSION_COOKIE]);

    p.win.amanda!("consent", { analytics: "denied" });
    await vi.advanceTimersByTimeAsync(0);

    expect(p.withdrawals).toHaveLength(1);
    const [signal] = p.withdrawals;
    expect(validateWithdrawal(signal!.body), JSON.stringify(validateWithdrawal.errors)).toBe(true);
    expect(signal!.body).toMatchObject({ site_id: "site_123", tag_version: "0.2.0", visitor_id: p.visitorId });
    expect(signal!.cookies).toEqual([VISITOR_COOKIE, SESSION_COOKIE]);
    expect(signal!.init).toMatchObject({ credentials: "omit", keepalive: true });
    expect(p.jar.live()).toEqual([]);
    expect(p.reports).toEqual([]);
  });

  it("on: the signal is the only request a declined-mode off site sends after the withdrawal", async () => {
    const p = await grantedPage("off", true);
    const before = p.requests().length;

    p.win.amanda!("consent", { analytics: "denied" });
    p.win.history.pushState(null, "", "/cart");
    await p.leave();

    expect(p.requests().slice(before)).toEqual([WITHDRAWAL_URL]);
  });

  it("on: one signal per withdrawal, each with the id the visitor had then", async () => {
    const p = await grantedPage("pings", true);
    p.win.amanda!("consent", { analytics: "denied" });
    p.win.amanda!("consent", { analytics: "denied" });
    await vi.advanceTimersByTimeAsync(0);
    expect(p.withdrawals.map((w) => w.body.visitor_id)).toEqual([p.visitorId]);

    // A grant after the denial mints a fresh visitor id; withdrawing again erases that one.
    p.win.amanda!("consent", { analytics: "granted" });
    const renewed = readCookie(p.jar.cookie, VISITOR_COOKIE)!.slice("v1.".length);
    expect(renewed).not.toBe(p.visitorId);
    p.win.amanda!("consent", { analytics: "denied" });
    await vi.advanceTimersByTimeAsync(0);
    expect(p.withdrawals.map((w) => w.body.visitor_id)).toEqual([p.visitorId, renewed]);
  });

  it("on: a visitor who never granted sends no signal when they decline", async () => {
    const p = page("off", [["consent", { analytics: "denied", ads: "denied" }]], { purge_on_withdrawal: true });
    await p.booted;
    await p.leave();
    expect(p.requests()).toEqual([CONFIG_URL]);
  });

  it.each([
    ["off by default", undefined],
    ["turned off", false],
  ] as const)("%s: a withdrawal only deletes the cookies", async (_, purge) => {
    const p = await grantedPage("off", purge);
    p.win.amanda!("consent", { analytics: "denied" });
    await vi.advanceTimersByTimeAsync(0);

    expect(p.withdrawals).toEqual([]);
    expect(p.requests()).not.toContain(WITHDRAWAL_URL);
    expect(p.jar.live()).toEqual([]);
  });
});
