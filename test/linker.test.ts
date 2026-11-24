// The cross-domain linker (AAI-218) end to end: the tag booted as a.js boots it (createFeed wired
// into boot, as src/core/tag.ts wires it) on two stand-in pages of one site, shop.example.com and
// www.example.de, each with its own cookie jar. A granted visitor who follows a link from one of the
// site's linker.domains to another carries their ids, and both pages' events carry the same visitor
// and session; a link is never decorated for a visitor who hasn't granted, to a domain outside the
// set, or on a site whose config lists no linker.domains. A landing adopts only a fresh value, on a
// page of the set, and only under granted consent; the parameter never reaches a url or referrer the
// tag sends.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boot } from "../src/core/boot";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import { ConfigError, linkerDomains, parseConfig } from "../src/core/config";
import { DEFAULT_ENDPOINT } from "../src/core/endpoint";
import { createFeed } from "../src/core/feed";
import { LINKER_PARAM, parseSession, parseVisitor, readCookie, SESSION_COOKIE, VISITOR_COOKIE } from "../src/core/identity";
import { decorate, LINKER_MAX_AGE_MS, linkedIds, linkerValue, linksAcross } from "../src/core/linker";
import type { AmandaFunction } from "../src/core/queue";
import { defaultTarget } from "../src/core/telemetry";
import { CookieJar } from "./cookie-jar";
import { fakeWindow, jsonResponse, scriptTag, type FakeDocument } from "./fake-window";
import { validator } from "./wire-validator";

const CONFIG_URL = `${DEFAULT_ENDPOINT}/cfg/site_123.json`;
const EVENTS_URL = `${DEFAULT_ENDPOINT}/v1/e`;
const SNIPPET = { src: "https://eu.serversider.com/a.js", "data-site": "site_123" };
const START = 1_731_400_000_000;
const SET = ["example.com", "example.de"];
const VISITOR = "01934f6c-8d2a-7b3c-8d4e-5f6a7b8c9d01";
const SESSION = "01934f6c-8d2a-7b3c-ad4e-5f6a7b8c9d02";
const GRANTED = ["consent", { analytics: "granted", ads: "granted" }];
const DENIED = ["consent", { analytics: "denied", ads: "denied" }];
const validateBatch = validator("batch.json");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The page's Element, as an <a>: closest finds the link itself, and its href can be rewritten. */
class FakeLink {
  #href: string;
  constructor(href: string) {
    this.#href = href;
  }
  closest(): FakeLink {
    return this;
  }
  getAttribute(name: string): string | null {
    return name === "href" ? this.#href : null;
  }
  setAttribute(name: string, value: string): void {
    if (name !== "href") throw new Error(`unexpected attribute ${name}`);
    this.#href = value;
  }
}

/**
 * The site's page on href, with the tag booted on it as a.js boots it, the site's config carrying
 * linker (no linker section when null), and the site's queued calls.
 */
function page(href: string, queued: unknown[][], linker: unknown = { domains: SET }) {
  const config = {
    schema_version: 1,
    site: "site_123",
    config_version: 7,
    domains: SET,
    ...(linker === null ? {} : { linker }),
  };
  const jar = new CookieJar(new URL(href).hostname, () => Date.now());
  const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(null, 404), href);
  win.fetchMock.mockImplementation(async (url: string) => (url === CONFIG_URL ? jsonResponse(config) : jsonResponse(null, 204)));
  const listeners: { type: string; listener: (event: { target: unknown; button?: number }) => void }[] = [];
  Object.assign(win.document, {
    addEventListener: (type: string, listener: (event: { target: unknown; button?: number }) => void) => {
      listeners.push({ type, listener });
    },
  });
  Object.assign(win, {
    Element: FakeLink,
    navigator: { language: "sv-SE", sendBeacon: () => true },
    setTimeout: (handler: () => void, timeout: number) => setTimeout(handler, timeout),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
  Object.defineProperty(win.document, "cookie", {
    get: () => jar.cookie,
    set: (value: string) => {
      jar.cookie = value;
    },
  });
  const stub: AmandaFunction = function (...args: unknown[]) {
    (stub.q = stub.q || []).push(args);
  };
  win.amanda = stub;
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
    consent: feed.consent,
    linker: feed.linker,
  });
  const events = () =>
    (win.fetchMock.mock.calls as [string, RequestInit][])
      .filter(([url]) => url === EVENTS_URL)
      .flatMap(([, init]) => {
        const batch = JSON.parse(init.body as string);
        expect(validateBatch(batch), JSON.stringify(validateBatch.errors)).toBe(true);
        return batch.e as { visitor_id: string; session_id: string; url: string; referrer?: string }[];
      });
  return {
    win,
    jar,
    booted,
    reports,
    events,
    /** The ids in the page's cookies, or undefined where there is none. */
    ids: () => ({
      visitorId: parseVisitor(readCookie(jar.cookie, VISITOR_COOKIE)),
      sessionId: parseSession(readCookie(jar.cookie, SESSION_COOKIE))?.id,
    }),
    /** Clicks a link to href with the primary button, and returns the href it then has. */
    follow: (linkHref: string): string => {
      const link = new FakeLink(linkHref);
      for (const entry of listeners) if (entry.type === "click") entry.listener({ target: link, button: 0 });
      return link.getAttribute("href")!;
    },
    /** Middle-clicks a link to href, and returns the href it then has. */
    middle: (linkHref: string): string => {
      const link = new FakeLink(linkHref);
      for (const entry of listeners) if (entry.type === "auxclick") entry.listener({ target: link, button: 1 });
      return link.getAttribute("href")!;
    },
  };
}

/** Boots a page and lets its first batch go. */
async function booted(href: string, queued: unknown[][], linker: unknown = { domains: SET }) {
  const p = page(href, queued, linker);
  await p.booted;
  await vi.advanceTimersByTimeAsync(0);
  return p;
}

describe("the cross-domain linker (AAI-218)", () => {
  it("carries a granted visitor's ids to another domain of the set: both domains' events carry the same visitor and session", async () => {
    const from = await booted("https://shop.example.com/cart", [GRANTED]);
    const ids = from.ids();
    expect(ids.visitorId).toBeDefined();

    const decorated = from.follow("https://www.example.de/kasse?step=2#pay");
    expect(decorated).toBe(`https://www.example.de/kasse?step=2&${LINKER_PARAM}=v1.${ids.visitorId}.${ids.sessionId}.${START}#pay`);

    vi.setSystemTime(START + 5_000);
    const to = await booted(new URL(decorated).href, [GRANTED]);

    const [event] = to.events();
    // The wire's url drops the fragment, as every event's does.
    expect(event).toMatchObject({ visitor_id: ids.visitorId, session_id: ids.sessionId, url: "https://www.example.de/kasse?step=2" });
    expect(from.events()[0]).toMatchObject({ visitor_id: ids.visitorId, session_id: ids.sessionId });
    // The landing domain's own cookies hold the carried ids from then on.
    expect(to.ids()).toEqual(ids);
    // Out of the address bar too, so that a copied URL or the next page's referrer doesn't carry them.
    expect(to.win.location.href).toBe("https://www.example.de/kasse?step=2#pay");
    expect(JSON.stringify(to.events())).not.toContain(LINKER_PARAM);
    expect([...from.reports, ...to.reports]).toEqual([]);
  });

  it("decorates a middle-clicked link, as a click", async () => {
    const from = await booted("https://shop.example.com/", [GRANTED]);

    expect(from.middle("https://example.de/")).toContain(`/?${LINKER_PARAM}=v1.${from.ids().visitorId}.`);
  });

  it.each([
    ["denied", [DENIED]],
    ["still undecided", []],
  ])("never decorates a link while analytics is %s, and writes no cookie", async (_, queued) => {
    const from = await booted("https://shop.example.com/", queued);

    expect(from.follow("https://www.example.de/")).toBe("https://www.example.de/");
    expect(from.jar.cookie).toBe("");
    expect(from.reports).toEqual([]);
  });

  it("decorates a relative link that a <base href> on another domain of the set sends there, as the browser follows it (AAI-1231)", async () => {
    const from = await booted("https://shop.example.com/products", [GRANTED]);
    (from.win.document as unknown as FakeDocument).base = "https://www.example.de/";

    expect(from.follow("kasse")).toBe(`kasse?${LINKER_PARAM}=v1.${from.ids().visitorId}.${from.ids().sessionId}.${START}`);
    expect(from.follow("https://shop.example.com/cart")).toBe("https://shop.example.com/cart");
    expect(from.reports).toEqual([]);
  });

  it("never decorates a relative link that a <base href> keeps on the page's own domain (AAI-1231)", async () => {
    const from = await booted("https://shop.example.com/products", [GRANTED]);
    (from.win.document as unknown as FakeDocument).base = "https://www.example.com/";

    expect(from.follow("kasse")).toBe("kasse");
    expect(from.reports).toEqual([]);
  });

  it("never carries a withdrawn visitor's ids on a link decorated before the withdrawal (AAI-1228)", async () => {
    const from = await booted("https://shop.example.com/", [GRANTED]);
    const withdrawn = from.ids();
    // target=_blank or a middle click: the page stays, its link decorated.
    const decorated = from.middle("https://www.example.de/?x=1#top");
    expect(decorated).toContain(withdrawn.visitorId);
    (from.win.amanda as AmandaFunction)(...DENIED);
    await vi.advanceTimersByTimeAsync(0);
    expect(from.ids().visitorId).toBeUndefined();

    vi.setSystemTime(START + 30_000);
    const href = from.follow(decorated);
    expect(href).toBe("https://www.example.de/?x=1#top");
    const to = await booted(href, [GRANTED]);
    expect(to.ids().visitorId).not.toBe(withdrawn.visitorId);
    expect([...from.reports, ...to.reports]).toEqual([]);
  });

  it("takes the parameter out of a link it doesn't decorate, outside the set too, and leaves the rest as written", async () => {
    const from = await booted("https://shop.example.com/", [DENIED]);

    expect(from.follow(`https://www.example.de/?${LINKER_PARAM}=v1.${VISITOR}.${SESSION}.${START}&q=a+b`)).toBe("https://www.example.de/?q=a+b");
    expect(from.follow(`https://partner.example.org/?${LINKER_PARAM}=x#y`)).toBe("https://partner.example.org/#y");
    expect(from.reports).toEqual([]);
  });

  it.each([
    ["a domain outside the set", "https://partner.example.org/offer"],
    ["the page's own host", "https://shop.example.com/cart"],
    ["another host under the page's listed domain, which shares its cookies", "https://www.example.com/"],
    ["a relative link", "/cart"],
    ["a mailto: link", "mailto:anna@example.de"],
    ["a malformed link", "https://exa mple.de:99999/"],
  ])("never decorates a link to %s", async (_, href) => {
    const from = await booted("https://shop.example.com/", [GRANTED]);

    expect(from.follow(href)).toBe(href);
    expect(from.reports).toEqual([]);
  });

  it.each([
    ["no linker section", null],
    ["linker.domains empty, as the publisher sends while the linker is off", { domains: [] }],
    ["a linker section without domains", {}],
  ])("is off with %s: no link is decorated, and a landing's ids are not adopted", async (_, linker) => {
    const from = await booted("https://shop.example.com/", [GRANTED], linker);
    expect(from.follow("https://www.example.de/")).toBe("https://www.example.de/");

    const to = await booted(`https://www.example.de/?a=1&${LINKER_PARAM}=v1.${VISITOR}.${SESSION}.${START}`, [GRANTED], linker);

    const [event] = to.events();
    expect(event!.visitor_id).not.toBe(VISITOR);
    expect(event!.url).toBe("https://www.example.de/?a=1");
    expect(to.win.location.href).toBe("https://www.example.de/?a=1");
    expect([...from.reports, ...to.reports]).toEqual([]);
  });

  it("never decorates on a page outside the set, and its landing adopts nothing", async () => {
    const from = await booted("https://staging.example.net/", [GRANTED]);
    expect(from.follow("https://example.de/")).toBe("https://example.de/");

    const to = await booted(`https://staging.example.net/?${LINKER_PARAM}=v1.${VISITOR}.${SESSION}.${START}`, [GRANTED]);
    expect(to.events()[0]!.visitor_id).not.toBe(VISITOR);
    expect(to.win.location.href).toBe("https://staging.example.net/");
  });

  it.each([
    ["older than two minutes", `v1.${VISITOR}.${SESSION}.${START - LINKER_MAX_AGE_MS - 1}`],
    ["from more than two minutes ahead", `v1.${VISITOR}.${SESSION}.${START + LINKER_MAX_AGE_MS + 1}`],
    ["of another version", `v2.${VISITOR}.${SESSION}.${START}`],
    ["without a session", `v1.${VISITOR}.${START}`],
    ["holding no UUIDv7", `v1.not-a-uuid.${SESSION}.${START}`],
  ])("does not adopt a value %s, and takes it out of the URL all the same", async (_, value) => {
    const to = await booted(`https://example.de/p?${LINKER_PARAM}=${encodeURIComponent(value)}`, [GRANTED]);

    const [event] = to.events();
    expect(event!.visitor_id).not.toBe(VISITOR);
    expect(event!.url).toBe("https://example.de/p");
    expect(to.reports).toEqual([]);
  });

  it("adopts a fresh value two minutes old, the limit", async () => {
    const to = await booted(`https://example.de/?${LINKER_PARAM}=v1.${VISITOR}.${SESSION}.${START - LINKER_MAX_AGE_MS}`, [GRANTED]);

    expect(to.events()[0]).toMatchObject({ visitor_id: VISITOR, session_id: SESSION });
  });

  it("holds the landing's ids while consent is undecided, and adopts them on the grant", async () => {
    const to = await booted(`https://example.de/?${LINKER_PARAM}=v1.${VISITOR}.${SESSION}.${START}`, []);
    expect(to.jar.cookie).toBe("");
    expect(to.win.location.href).toBe("https://example.de/");

    vi.setSystemTime(START + 60 * 60 * 1000);
    (to.win.amanda as AmandaFunction)(...GRANTED);
    await vi.advanceTimersByTimeAsync(0);

    expect(to.events()[0]).toMatchObject({ visitor_id: VISITOR, session_id: SESSION });
    expect(to.ids()).toEqual({ visitorId: VISITOR, sessionId: SESSION });
  });

  it("drops the landing's ids when the visitor declines: a later grant mints fresh ones", async () => {
    const to = await booted(`https://example.de/?${LINKER_PARAM}=v1.${VISITOR}.${SESSION}.${START}`, [DENIED]);
    expect(to.jar.cookie).toBe("");

    (to.win.amanda as AmandaFunction)(...GRANTED);
    (to.win.amanda as AmandaFunction)("pageview");
    await vi.advanceTimersByTimeAsync(5_000);

    const events = to.events();
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(event.visitor_id).not.toBe(VISITOR);
    expect(to.ids().visitorId).not.toBe(VISITOR);
  });

  it("takes the place of the landing domain's own earlier ids", async () => {
    const p = page(`https://example.de/?${LINKER_PARAM}=v1.${VISITOR}.${SESSION}.${START}`, [GRANTED]);
    const earlier = "01934f6c-0000-7000-8000-000000000001";
    p.jar.cookie = `${VISITOR_COOKIE}=v1.${earlier}; Max-Age=1000; Domain=.example.de; Path=/; SameSite=Lax; Secure`;
    await p.booted;
    await vi.advanceTimersByTimeAsync(0);

    expect(p.events()[0]).toMatchObject({ visitor_id: VISITOR });
  });

  it("leaves the parameter out of a referrer the tag sends", async () => {
    const to = await booted(`https://example.de/a`, [GRANTED]);
    // A page that pushes a decorated URL itself: the route change's referrer is the previous URL.
    to.win.history.pushState(null, "", `/b?${LINKER_PARAM}=x`);
    to.win.history.pushState(null, "", "/c");
    await vi.advanceTimersByTimeAsync(5_000);

    const sent = JSON.stringify(to.events());
    expect(sent).not.toContain(LINKER_PARAM);
    expect(to.events().map((e) => e.referrer)).toContain("https://example.de/b");
  });
});

describe("decorate", () => {
  it.each([
    ["https://example.de/", "https://example.de/?_amnda_lnk=V"],
    ["https://example.de/?", "https://example.de/?_amnda_lnk=V"],
    ["https://example.de/p?q=a+b&r=%2F#top", "https://example.de/p?q=a+b&r=%2F&_amnda_lnk=V#top"],
    ["https://example.de/#?not-a-query", "https://example.de/?_amnda_lnk=V#?not-a-query"],
    ["https://example.de/?_amnda_lnk=OLD&x=1", "https://example.de/?x=1&_amnda_lnk=V"],
    ["//example.de/p", "//example.de/p?_amnda_lnk=V"],
  ])("decorates %s as %s, leaving the rest as written", (href, expected) => {
    expect(decorate(href, "V")).toBe(expected);
  });
});

describe("linksAcross", () => {
  it("is false for a page or link outside the set, and between hosts under one listed domain", () => {
    const across = (href: string, pageUrl: string, domains = SET) => linksAcross(href, pageUrl, pageUrl, domains);
    expect(across("https://a.example.de/", "https://shop.example.com/")).toBe(true);
    expect(across("https://EXAMPLE.DE./", "https://shop.example.com/")).toBe(true);
    expect(across("https://example.org/", "https://shop.example.com/")).toBe(false);
    expect(across("https://example.de/", "https://example.net/")).toBe(false);
    expect(across("https://a.example.de/", "https://b.example.de/")).toBe(false);
    expect(across("ftp://example.de/", "https://shop.example.com/")).toBe(false);
    expect(across("https://example.de/", "https://shop.example.com/", [])).toBe(false);
  });

  it("resolves a relative link against the document's base URL, and takes the page's host from its own URL (AAI-1231)", () => {
    const page = "https://shop.example.com/products";
    expect(linksAcross("kasse", "https://www.example.de/", page, SET)).toBe(true);
    expect(linksAcross("kasse", page, page, SET)).toBe(false);
    // A base on another domain of the set doesn't make the page's own links cross.
    expect(linksAcross("https://shop.example.com/cart", "https://www.example.de/", page, SET)).toBe(false);
  });
});

describe("linkedIds", () => {
  it("reads back what linkerValue writes, within the time limit only", () => {
    const value = linkerValue({ visitorId: VISITOR, sessionId: SESSION }, START);
    expect(linkedIds(value, START)).toEqual({ visitorId: VISITOR, sessionId: SESSION });
    expect(linkedIds(value, START + LINKER_MAX_AGE_MS + 1)).toBeUndefined();
    expect(linkedIds(`${value}.extra`, START)).toBeUndefined();
    expect(linkedIds("", START)).toBeUndefined();
  });
});

describe("the config's linker section", () => {
  const config = (linker: unknown) => ({ schema_version: 1, site: "site_123", config_version: 1, linker });

  it("reads linker.domains as the site's domains are read", () => {
    expect(linkerDomains(parseConfig(config({ domains: ["Example.DE.", "shop.example.com"] }), "site_123"))).toEqual([
      "example.de",
      "shop.example.com",
    ]);
    expect(linkerDomains(parseConfig({ schema_version: 1, site: "site_123", config_version: 1 }, "site_123"))).toEqual([]);
  });

  it.each([
    ["a section that is not an object", ["example.de"]],
    ["domains that is not a list", { domains: "example.de" }],
    ["a domain that is not a hostname", { domains: ["https://example.de/"] }],
  ])("refuses %s", (_, linker) => {
    expect(() => parseConfig(config(linker), "site_123")).toThrow(ConfigError);
  });
});
