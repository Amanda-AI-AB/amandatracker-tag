// Declined mode `pings` (AAI-87): the anonymous ping a pageview becomes, and end to end, what a
// visitor who declined sends: pings that carry exactly ping.json's frozen field list, in batches
// without seq, and no cookies.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boot } from "../src/core/boot";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import { declinedMode } from "../src/core/config";
import { createConsent, type ConsentMachine } from "../src/core/consent";
import { DEFAULT_ENDPOINT } from "../src/core/endpoint";
import { pageviewInput, type PageviewInput } from "../src/core/pageview";
import { pingInput, pingOf, pingPath, referrerHost, UTM_FIELDS, utmOf } from "../src/core/ping";
import type { AmandaFunction } from "../src/core/queue";
import { createTransport } from "../src/core/transport";
import { WIRE_PING_SHAPE } from "../src/wire/generated";
import { PING_ID_PERIOD_MS, WirePayloadError } from "../src/wire/payload";
import { fakeWindow, jsonResponse, scriptTag, type FakeWindow } from "./fake-window";
import { UUID7, validator } from "./wire-validator";

const validatePing = validator("ping.json");
const validateBatch = validator("batch.json");

/** The frozen field list (08 G2): what a ping may carry, and all it may. */
const FROZEN = ["event_id", "path", "referrer_host", "schema_version", "site_id", "type", "utm"];

const LANDING =
  "https://shop.example/products/shoes?utm_source=newsletter&utm_medium=email&utm_campaign=nov&utm_term=red&utm_content=hero" +
  "&gclid=abc&fbclid=def&msclkid=ghi&email=jane@example.com#section";

/** Everything a pageview, an identified event and a purchase could hold, on one item. */
function everything(): PageviewInput {
  return {
    type: "pageview",
    site_id: "site_123",
    tag_version: "0.2.0",
    client_ts: 1_731_400_123_456,
    url: LANDING,
    referrer: "https://mail.example:8443/inbox?id=42#msg",
    page_title: "Shoes for Jane",
    language: "sv-SE",
    visitor_id: "01934f6c-8d2a-7b3c-8d4e-5f6a7b8c9d01",
    session_id: "01934f6c-8d2a-7b3c-ad4e-5f6a7b8c9d02",
    seq: 4,
    consent: { analytics: "denied", ads: "denied" },
    props: { plan: "pro" },
    gclid: "abc",
    purchase: { order_id: "1001", revenue: 249.9, currency: "SEK", items: [] },
    order_id: "1001",
    revenue: 249.9,
  } as unknown as PageviewInput;
}

describe("the ping field list", () => {
  it("is ping.json's, frozen: the generated shape lists exactly these fields", () => {
    expect([...WIRE_PING_SHAPE.fields].sort()).toEqual(FROZEN);
    expect([...WIRE_PING_SHAPE.nested.utm!.fields].sort()).toEqual([...UTM_FIELDS].sort());
  });

  it("has no field for seq, ids, client time, language, props, click ids, order_id or revenue", () => {
    const linkable = ["seq", "visitor_id", "session_id", "client_ts", "tag_version", "language", "url", "referrer"];
    const extra = ["page_title", "props", "consent", "gclid", "fbclid", "msclkid", "click_ids", "purchase", "order_id", "revenue"];
    for (const field of [...linkable, ...extra]) expect(WIRE_PING_SHAPE.fields).not.toContain(field);
  });
});

describe("pingOf", () => {
  it("carries exactly the frozen fields, whatever the item holds", () => {
    const ping = pingOf(everything(), UUID7);
    expect(Object.keys(ping).sort()).toEqual(FROZEN);
    expect(ping).toEqual({
      schema_version: 1,
      event_id: UUID7,
      site_id: "site_123",
      type: "pageview",
      path: "/products/shoes",
      referrer_host: "mail.example",
      utm: { source: "newsletter", medium: "email", campaign: "nov", term: "red", content: "hero" },
    });
    expect(validatePing(ping), JSON.stringify(validatePing.errors)).toBe(true);
  });

  it("sends no click id, order, revenue, id, seq or anything of the query or fragment", () => {
    // A fixed event_id: a random one's hex could hold "abc" or "def" by chance.
    const body = JSON.stringify(pingOf(everything(), UUID7));
    for (const leak of ["abc", "def", "ghi", "1001", "249.9", "jane", "section", "8443", "inbox", "msg", "sv-SE", "Shoes for", "plan"]) {
      expect(body).not.toContain(leak);
    }
    expect(body).not.toContain("01934f6c-8d2a-7b3c-8d4e");
    expect(body).not.toContain("01934f6c-8d2a-7b3c-ad4e");
  });

  it("goes with only the required fields when the page has no referrer and no UTM", () => {
    const ping = pingOf({ type: "pageview", site_id: "site_123", url: "https://shop.example/" });
    expect(Object.keys(ping).sort()).toEqual(["event_id", "path", "schema_version", "site_id", "type"]);
    expect(ping.path).toBe("/");
    expect(validatePing(ping), JSON.stringify(validatePing.errors)).toBe(true);
  });

  it("has an event_id whose time is only the hour", () => {
    const ping = pingOf(everything());
    const ms = parseInt(ping.event_id.replace(/-/g, "").slice(0, 12), 16);
    expect(ms % PING_ID_PERIOD_MS).toBe(0);
  });

  it("differs in nothing but event_id between two pings of the same page", () => {
    const a = pingOf(everything());
    const b = pingOf({ ...everything(), client_ts: 1, visitor_id: "other" } as unknown as PageviewInput);
    expect(a.event_id).not.toBe(b.event_id);
    expect({ ...a, event_id: "" }).toEqual({ ...b, event_id: "" });
  });

  it("refuses an item whose url isn't absolute, and a page whose URL has no path", () => {
    expect(() => pingOf({ type: "pageview", site_id: "site_123", url: "/relative" })).toThrow(TypeError);
    expect(() => pingOf({ type: "pageview", site_id: "site_123", url: "about:blank" })).toThrow(WirePayloadError);
  });

  it("is made from a pageview as the tag builds it", () => {
    const page = {
      location: { href: LANDING },
      document: { title: "Shoes", referrer: "https://search.example/q?x=jane@example.com" },
      navigator: { language: "sv-SE" },
    };
    const ping = pingOf(pageviewInput(page, "site_123", "0.2.0", page.document.referrer));
    expect(ping.path).toBe("/products/shoes");
    expect(ping.referrer_host).toBe("search.example");
    expect(validatePing(ping), JSON.stringify(validatePing.errors)).toBe(true);
  });
});

describe("pingPath", () => {
  it.each([
    ["https://a.example/reset?email=jane@example.com&token=abc#frag", "/reset"],
    ["https://a.example/users/jane@example.com/orders", "/users/<email>/orders"],
    ["https://a.example/users/jane%40example.com", "/users/<email>"],
    ["https://a.example/u/JANE%40Example.COM?x=1", "/u/<email>"],
    ["https://a.example/@jane", "/@jane"],
    ["https://a.example", "/"],
  ])("%s -> %s", (url, path) => {
    expect(pingPath(new URL(url))).toBe(path);
    expect(path).toMatch(new RegExp(WIRE_PING_SHAPE.pattern.path!, "u"));
  });
});

describe("referrerHost", () => {
  it.each([
    [undefined, undefined],
    ["", undefined],
    ["https://Mail.Example:8443/inbox?id=42#msg", "mail.example"],
    ["https://user:secret@mail.example/", "mail.example"],
    ["http://www.google.com/", "www.google.com"],
    ["https://bücher.example/", "xn--bcher-kva.example"],
    ["android-app://com.example.app/", "com.example.app"],
    ["about:blank", undefined],
    ["not a url", undefined],
  ])("%s -> %s", (referrer, host) => {
    expect(referrerHost(referrer)).toBe(host);
  });

  it("lets buildPing drop a hostname off ping.json's pattern, such as an IPv6 address", () => {
    expect(referrerHost("http://[::1]/")).toBe("[::1]");
    const ping = pingOf({ type: "pageview", site_id: "site_123", url: "https://a.example/", referrer: "http://[::1]/" });
    expect(ping).not.toHaveProperty("referrer_host");
  });
});

describe("utmOf", () => {
  it("reads the five utm_ parameters, decoded, and nothing else", () => {
    const url = new URL("https://a.example/?utm_source=news%20letter&utm_medium=&utm_id=7&gclid=abc&UTM_CAMPAIGN=x");
    expect(utmOf(url)).toEqual({ source: "news letter" });
  });

  it("is undefined when no utm_ parameter is set", () => {
    expect(utmOf(new URL("https://a.example/?gclid=abc"))).toBeUndefined();
  });

  it("leaves capping a long value to buildPing", () => {
    const input = pingInput({ type: "pageview", site_id: "s", url: `https://a.example/?utm_campaign=${"c".repeat(300)}` });
    expect(input.utm!.campaign).toHaveLength(300);
    const ping = pingOf({ type: "pageview", site_id: "s", url: `https://a.example/?utm_campaign=${"c".repeat(300)}` });
    expect(ping.utm!.campaign).toHaveLength(256);
  });
});

// End to end: the boot, the consent sources, the state machine and the transport wired together as
// a.js is to wire them (AAI-964), with the sink's `anonymous` sending pingOf's pings.

const CONFIG = { schema_version: 1, site: "site_123", config_version: 7, consent: { declined_mode: "pings" } } as const;
const CONFIG_URL = `${DEFAULT_ENDPOINT}/cfg/site_123.json`;
const URL_E = `${DEFAULT_ENDPOINT}/v1/e`;
const SNIPPET = { src: "https://eu.serversider.com/a.js", "data-site": "site_123" };

let cookieWrites: string[];

beforeEach(() => {
  vi.useFakeTimers();
  cookieWrites = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function snippetStub(win: FakeWindow): AmandaFunction {
  const stub: AmandaFunction = function (...args: unknown[]) {
    (stub.q = stub.q || []).push(args);
  };
  win.amanda = stub;
  return stub;
}

function page(href: string) {
  const win = fakeWindow(scriptTag(SNIPPET), async () => jsonResponse(CONFIG), href);
  win.fetchMock.mockImplementation(async (url: string) => (url === CONFIG_URL ? jsonResponse(CONFIG) : jsonResponse(null, 204)));
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
  Object.defineProperty(win.document, "cookie", {
    get: () => "",
    set: (value: string) => cookieWrites.push(value),
  });

  const reports: ErrorReport[] = [];
  const boundary = new ErrorBoundary((report) => reports.push(report), 1);
  const identified: PageviewInput[] = [];
  let machine: ConsentMachine<PageviewInput> | undefined;
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
          identified: (input) => identified.push(input),
          anonymous: (input) => transport.ping(pingOf(input)),
          withdraw: () => transport.withdrawEvents(),
        },
        identity: { forget: () => undefined, renew: () => undefined },
      });
      return machine;
    },
  });

  const posts = () => win.fetchMock.mock.calls.filter((call) => call[0] === URL_E);
  return {
    win,
    booted,
    reports,
    identified,
    beacons: () => beacon.mock.calls.length,
    /** The /v1/e bodies, parsed. */
    batches: () => posts().map((call) => JSON.parse((call[1] as RequestInit).body as string)),
    inits: () => posts().map((call) => call[1] as RequestInit),
    leave: async () => {
      for (const listener of pagehide) listener();
      await vi.advanceTimersByTimeAsync(60_000);
    },
  };
}

describe("declined mode pings: a visitor who declined sends only anonymous pings", () => {
  it("is a site's declined mode when its config says so", () => {
    expect(declinedMode(CONFIG)).toBe("pings");
  });

  it("denied before the tag loads: each pageview goes as a ping with the frozen fields, no seq and no cookies", async () => {
    const p = page(LANDING);
    snippetStub(p.win)("consent", { analytics: "denied", ads: "denied" });
    await p.booted;
    p.win.history.pushState(null, "", "/cart?coupon=NOV10");
    await vi.advanceTimersByTimeAsync(60_000);

    const batches = p.batches();
    expect(batches.length).toBeGreaterThan(0);
    for (const batch of batches) {
      expect(validateBatch(batch), JSON.stringify(validateBatch.errors)).toBe(true);
      expect(Object.keys(batch)).toEqual(["e"]);
    }
    const pings = batches.flatMap((batch) => batch.e as Record<string, unknown>[]);
    expect(pings.map((ping) => ping.path)).toEqual(["/products/shoes", "/cart"]);
    for (const ping of pings) {
      expect(Object.keys(ping).every((field) => FROZEN.includes(field))).toBe(true);
      expect(validatePing(ping), JSON.stringify(validatePing.errors)).toBe(true);
    }
    expect(pings[0]).toMatchObject({
      referrer_host: "search.example",
      utm: { source: "newsletter", medium: "email", campaign: "nov", term: "red", content: "hero" },
    });
    // Without event_id, whose random hex could hold "abc" or "def" by chance.
    const sent = JSON.stringify(pings.map(({ event_id, ...rest }) => rest));
    expect(sent).not.toMatch(/abc|def|ghi|jane|NOV10|seq|visitor|session/);
    expect(p.inits().every((init) => init.credentials === "omit")).toBe(true);
    expect(p.identified).toEqual([]);
    expect(cookieWrites).toEqual([]);
    expect(p.reports).toEqual([]);
  });

  it("unknown, then denied: the pending pageview goes as a ping", async () => {
    const p = page("https://shop.example/");
    await p.booted;
    (p.win.dataLayer as unknown[]).push(["consent", "update", { analytics_storage: "denied" }]);
    await vi.advanceTimersByTimeAsync(60_000);

    const pings = p.batches().flatMap((batch) => batch.e as Record<string, unknown>[]);
    expect(pings).toHaveLength(1);
    expect(Object.keys(pings[0]!).sort()).toEqual(["event_id", "path", "referrer_host", "schema_version", "site_id", "type"]);
    expect(p.reports).toEqual([]);
  });

  it("still unknown when the page goes: the pending pageview leaves as a ping, without a beacon", async () => {
    const p = page("https://shop.example/");
    await p.booted;
    await p.leave();

    const pings = p.batches().flatMap((batch) => batch.e as Record<string, unknown>[]);
    expect(pings).toHaveLength(1);
    expect(p.beacons()).toBe(0);
    expect(p.inits().every((init) => init.credentials === "omit")).toBe(true);
    expect(p.reports).toEqual([]);
  });
});
