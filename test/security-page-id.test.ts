// Regression test for AAI-1156: a grant after a withdrawal starts a new page_id, so that the
// withdrawn visitor id and the fresh one a re-grant mints are never joined through it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boot } from "../src/core/boot";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import { DEFAULT_ENDPOINT } from "../src/core/endpoint";
import { createFeed } from "../src/core/feed";
import type { AmandaFunction } from "../src/core/queue";
import { defaultTarget } from "../src/core/telemetry";
import { CookieJar } from "./cookie-jar";
import { fakeWindow, jsonResponse, PAGE, scriptTag } from "./fake-window";

const CONFIG_URL = `${DEFAULT_ENDPOINT}/cfg/site_123.json`;
const EVENTS_URL = `${DEFAULT_ENDPOINT}/v1/e`;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(["off", "pings"] as const)("security: page_id across a withdrawal (declined mode %s)", (declinedMode) => {
  it("test_regrant_after_withdrawal_does_not_link_old_and_new_visitor_by_page_id", async () => {
    const config = { schema_version: 1, site: "site_123", config_version: 7, consent: { declined_mode: declinedMode }, features: {} };
    const jar = new CookieJar("shop.example.com", () => Date.now());
    const win = fakeWindow(scriptTag({ src: "https://eu.serversider.com/a.js", "data-site": "site_123" }), jsonResponse(null, 404), `${PAGE}/`);
    win.fetchMock.mockImplementation(async (url: string) => (url === CONFIG_URL ? jsonResponse(config) : jsonResponse(null, 204)));
    Object.assign(win, {
      navigator: { language: "sv-SE", sendBeacon: vi.fn(() => true) },
      setTimeout: (h: () => void, t: number) => setTimeout(h, t),
      clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    Object.assign(win.document, { addEventListener: () => undefined });
    Object.defineProperty(win.document, "visibilityState", { get: () => "visible" });
    Object.defineProperty(win.document, "cookie", { get: () => jar.cookie, set: (v: string) => void (jar.cookie = v) });
    const stub: AmandaFunction = function (...args: unknown[]) {
      (stub.q = stub.q || []).push(args);
    };
    win.amanda = stub;
    stub("consent", { analytics: "granted", ads: "granted" });
    const reports: ErrorReport[] = [];
    const boundary = new ErrorBoundary((r) => reports.push(r), 1);
    const target = defaultTarget();
    const feed = createFeed(win, boundary, target, "0.2.0");
    await boot(win, {
      tagVersion: "0.2.0", boundary, target,
      onPageview: feed.pageview, onPageExit: feed.pageExit, onEvent: feed.event, onEcommerce: feed.ecommerce,
      onPurchase: feed.purchase, onIdentify: feed.identify, onFormSubmit: feed.formSubmit,
      onClickSpecial: feed.clickSpecial, onClickOutbound: feed.clickOutbound, consent: feed.consent,
    });
    await vi.advanceTimersByTimeAsync(60_000);

    // Withdraw, then grant again on the same page: identity mints a fresh visitor id (README "Withdrawal").
    win.amanda!("consent", { analytics: "denied", ads: "denied" });
    win.amanda!("consent", { analytics: "granted", ads: "granted" });
    win.history.pushState(null, "", "/cart");
    await vi.advanceTimersByTimeAsync(60_000);

    const batches = (win.fetchMock.mock.calls as [string, RequestInit][])
      .filter(([url]) => url === EVENTS_URL)
      .map(([, init]) => JSON.parse(init.body as string))
      .filter((b) => b.seq !== undefined);
    expect(batches.length, JSON.stringify({ batches, reports })).toBe(2);
    const [before, after] = batches;
    expect(before.e[0].visitor_id).not.toBe(after.e[0].visitor_id);
    // The fresh visitor id must not be joinable to the withdrawn one.
    expect(
      after.page_id,
      `visitor ${before.e[0].visitor_id} and visitor ${after.e[0].visitor_id} share page_id ${before.page_id}`,
    ).not.toBe(before.page_id);
    // seq starts again for the new page key, so it doesn't link them either, and stays gapless: the
    // route change's page_exit, sent by beacon, takes the new key's seq 1, and its pageview seq 2.
    const beacons = ((win.navigator as unknown as { sendBeacon: ReturnType<typeof vi.fn> }).sendBeacon.mock.calls as [string, string][])
      .filter(([url]) => url === EVENTS_URL)
      .map(([, body]) => JSON.parse(body));
    const keys = [...batches, ...beacons].map((b) => ({ page: b.page_id === before.page_id ? "old" : "new", seq: b.seq, types: b.e.map((e: { type: string }) => e.type) }));
    expect(keys).toEqual([
      { page: "old", seq: 1, types: ["pageview"] },
      { page: "new", seq: 2, types: ["pageview"] },
      { page: "new", seq: 1, types: ["page_exit"] },
    ]);
    expect(beacons.every((b) => b.e.every((e: { visitor_id: string }) => e.visitor_id === after.e[0].visitor_id))).toBe(true);
  });
});
