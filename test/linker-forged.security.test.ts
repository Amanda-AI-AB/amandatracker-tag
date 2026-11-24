// AAI-1237: the linker's parameter is unsigned, so a page outside the site's linker.domains could
// mint a fresh value and plant its chosen ids over a visitor's own. A landing adopts only from a
// referrer on another domain of the set (linker.ts, landsAcross).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boot } from "../src/core/boot";
import { ErrorBoundary } from "../src/core/boundary";
import { DEFAULT_ENDPOINT } from "../src/core/endpoint";
import { createFeed } from "../src/core/feed";
import { LINKER_PARAM, parseVisitor, readCookie, VISITOR_COOKIE } from "../src/core/identity";
import type { AmandaFunction } from "../src/core/queue";
import { defaultTarget } from "../src/core/telemetry";
import { CookieJar } from "./cookie-jar";
import { fakeWindow, jsonResponse, scriptTag } from "./fake-window";

const CONFIG_URL = `${DEFAULT_ENDPOINT}/cfg/site_123.json`;
const SNIPPET = { src: "https://eu.serversider.com/a.js", "data-site": "site_123" };
const START = 1_731_400_000_000;
const SET = ["example.com", "example.de"];
const ATTACKER_VISITOR = "01934f6c-8d2a-7b3c-8d4e-5f6a7b8c9d01";
const ATTACKER_SESSION = "01934f6c-8d2a-7b3c-ad4e-5f6a7b8c9d02";
const GRANTED = ["consent", { analytics: "granted", ads: "granted" }];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function bootOn(href: string, jar: CookieJar) {
  const config = { schema_version: 1, site: "site_123", config_version: 7, domains: SET, linker: { domains: SET } };
  const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(null, 404), href);
  win.fetchMock.mockImplementation(async (url: string) => (url === CONFIG_URL ? jsonResponse(config) : jsonResponse(null, 204)));
  Object.assign(win.document, { addEventListener: () => {} });
  Object.assign(win, {
    Element: class {},
    navigator: { language: "sv-SE", sendBeacon: () => true },
    setTimeout: (h: () => void, t: number) => setTimeout(h, t),
    clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  Object.defineProperty(win.document, "cookie", { get: () => jar.cookie, set: (v: string) => (jar.cookie = v) });
  const stub: AmandaFunction = function (...args: unknown[]) {
    (stub.q = stub.q || []).push(args);
  };
  win.amanda = stub;
  stub(...GRANTED);
  const boundary = new ErrorBoundary(() => {}, 1);
  const target = defaultTarget();
  const feed = createFeed(win, boundary, target, "0.2.0");
  await boot(win, { tagVersion: "0.2.0", boundary, target, onPageview: feed.pageview, consent: feed.consent, linker: feed.linker });
  await vi.advanceTimersByTimeAsync(0);
}

describe("security", () => {
  it("never lets a page outside the set plant its chosen ids over a visitor's own", async () => {
    const jar = new CookieJar("www.example.de", () => Date.now());
    await bootOn("https://www.example.de/", jar);
    const mine = parseVisitor(readCookie(jar.cookie, VISITOR_COOKIE));
    expect(mine).toBeDefined();

    // A page on search.example (the fake document's referrer, outside the set) mints a fresh value.
    vi.setSystemTime(START + 3_600_000);
    const forged = `https://www.example.de/?${LINKER_PARAM}=v1.${ATTACKER_VISITOR}.${ATTACKER_SESSION}.${Date.now()}`;
    await bootOn(forged, jar);

    expect(parseVisitor(readCookie(jar.cookie, VISITOR_COOKIE))).toBe(mine);
  });
});
