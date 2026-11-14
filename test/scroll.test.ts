import { afterEach, describe, expect, it, vi } from "vitest";
import { boot } from "../src/core/boot";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import { SCROLL_THRESHOLDS, scrollDepth, watchScroll, type ScrollDepthInput, type ScrollHost } from "../src/core/scroll";
import { buildEvent } from "../src/wire/payload";
import { fakeWindow, jsonResponse, PAGE, scriptTag, type FakeWindow } from "./fake-window";
import { validator } from "./wire-validator";

const CONFIG = { schema_version: 1, site: "site_123", config_version: 7 };
const SNIPPET = { src: "https://eu.serversider.com/a.js", "data-site": "site_123" };
const START = 1_731_400_000_000;

/** The page's height and the viewport's, in pixels: 25 % depth is at scrollY 0, 90 % at scrollY 3500. */
const PAGE_HEIGHT = 5000;
const VIEWPORT = 1000;

/** Gives win a page PAGE_HEIGHT tall, seen through a viewport VIEWPORT tall, scrolled to the top. */
function scrollable(win: FakeWindow, height = PAGE_HEIGHT): { scrollTo(y: number): void } {
  Object.assign(win.document, { documentElement: { scrollHeight: height } });
  Object.assign(win, { scrollY: 0, innerHeight: VIEWPORT });
  return {
    /** Scrolls win to y, and fires its scroll event. */
    scrollTo(y: number) {
      Object.assign(win, { scrollY: y });
      win.fire("scroll");
    },
  };
}

/** A booted tag with onScrollDepth, its scroll events and pageviews, on a page the test scrolls. */
function scrollPage(onScrollDepth: boolean | ((input: ScrollDepthInput) => void) = true) {
  const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(CONFIG));
  const page = scrollable(win);
  const reports: ErrorReport[] = [];
  const scrolls: ScrollDepthInput[] = [];
  const pageviews: string[] = [];
  const boundary = new ErrorBoundary((report) => reports.push(report), 1);
  const handler = typeof onScrollDepth === "function" ? onScrollDepth : (input: ScrollDepthInput) => scrolls.push(input);
  const booted = boot(win, {
    tagVersion: "0.2.0",
    boundary,
    onPageview: (input) => pageviews.push(input.url),
    ...(onScrollDepth === false ? {} : { onScrollDepth: handler }),
    now: () => START,
  });
  return { win, booted, reports, scrolls, pageviews, ...page };
}

/** The wire event of a scroll event, once identity and consent have made it one. */
function wireEvent(input: ScrollDepthInput) {
  return buildEvent({
    ...input,
    visitor_id: "01934f6c-8d2a-7b3c-8d4e-5f6a7b8c9d01",
    session_id: "01934f6c-8d2a-7b3c-ad4e-5f6a7b8c9d02",
    consent: { analytics: "granted", ads: "granted" },
  });
}

/** The scrollY at which the viewport's bottom edge is at percent of the page. */
function at(percent: number): number {
  return (PAGE_HEIGHT * percent) / 100 - VIEWPORT;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("scroll depth (AAI-171)", () => {
  it("fires once per threshold, as the visitor reaches 25, 50, 75 and 90 %", async () => {
    const { booted, scrolls, scrollTo, reports } = scrollPage();
    await booted;

    scrollTo(at(25) + 10);
    scrollTo(at(40));
    scrollTo(at(50));
    scrollTo(at(75));
    scrollTo(at(89));
    scrollTo(at(90));
    scrollTo(at(100));

    expect(scrolls.map((s) => s.props.percent_scrolled)).toEqual([25, 50, 75, 90]);
    expect(scrolls[0]).toEqual({
      type: "scroll",
      site_id: "site_123",
      tag_version: "0.2.0",
      client_ts: START,
      url: `${PAGE}/products?id=1`,
      page_title: "Products",
      language: "sv-SE",
      props: { percent_scrolled: 25 },
    });
    const validate = validator("event.json");
    for (const scroll of scrolls) {
      const event = wireEvent(scroll);
      expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
      expect(event.type).toBe("scroll");
    }
    expect(reports).toEqual([]);
  });

  it("never fires a threshold twice in a pageview, however the visitor scrolls back and forth", async () => {
    const { booted, scrolls, scrollTo } = scrollPage();
    await booted;

    for (let i = 0; i < 3; i++) {
      scrollTo(at(60));
      scrollTo(0);
    }
    scrollTo(at(100));
    scrollTo(0);
    scrollTo(at(100));

    expect(scrolls.map((s) => s.props.percent_scrolled)).toEqual([25, 50, 75, 90]);
  });

  it("fires each threshold one scroll passes, in ascending order", async () => {
    const { booted, scrolls, scrollTo } = scrollPage();
    await booted;

    scrollTo(at(80));

    expect(scrolls.map((s) => s.props.percent_scrolled)).toEqual([25, 50, 75]);
  });

  it("fires the thresholds again in the next pageview, after a route change", async () => {
    const { win, booted, scrolls, pageviews, scrollTo } = scrollPage();
    await booted;
    scrollTo(at(100));

    win.history.pushState({}, "", "/cart");
    scrollTo(at(50));

    expect(pageviews).toEqual([`${PAGE}/products?id=1`, `${PAGE}/cart`]);
    expect(scrolls.map((s) => [s.url, s.props.percent_scrolled])).toEqual([
      [`${PAGE}/products?id=1`, 25],
      [`${PAGE}/products?id=1`, 50],
      [`${PAGE}/products?id=1`, 75],
      [`${PAGE}/products?id=1`, 90],
      [`${PAGE}/cart`, 25],
      [`${PAGE}/cart`, 50],
    ]);
  });

  it("is off by default: without onScrollDepth, no scroll is ever measured or listened for", async () => {
    const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(CONFIG));
    const added = vi.spyOn(win, "addEventListener");
    const boundary = new ErrorBoundary(() => undefined, 1);
    const read = vi.fn(() => 0);
    Object.defineProperty(win, "scrollY", { get: read });

    await boot(win, { tagVersion: "0.2.0", boundary, onPageview: () => undefined });
    win.fire("scroll");

    expect(added.mock.calls.map(([type]) => type)).not.toContain("scroll");
    expect(read).not.toHaveBeenCalled();
  });

  it("sends nothing until the visitor scrolls", async () => {
    const { booted, scrolls } = scrollPage();
    await booted;

    expect(scrolls).toEqual([]);
  });

  it("starts measuring only once the tag has booted", () => {
    const { scrolls, scrollTo } = scrollPage();

    scrollTo(at(100));

    expect(scrolls).toEqual([]);
  });

  it("reports a failure in the listener instead of throwing it into the page, and doesn't send that threshold again", async () => {
    let calls = 0;
    const { booted, reports, scrollTo } = scrollPage(() => {
      calls += 1;
      throw new TypeError("boom");
    });
    await booted;

    expect(() => scrollTo(at(30))).not.toThrow();
    scrollTo(at(30));

    expect(calls).toBe(1);
    expect(reports).toEqual([{ stage: "pageview", name: "TypeError", message: "boom" }]);
  });
});

describe("watchScroll", () => {
  function host(height: number, y: number): ScrollHost & { fire(): void; move(y: number): void } {
    let listener: () => void = () => undefined;
    const h = {
      document: { documentElement: { scrollHeight: height } },
      scrollY: y,
      innerHeight: VIEWPORT,
      addEventListener: (_type: "scroll", l: () => void) => (listener = l),
      fire: () => listener(),
      move(to: number) {
        h.scrollY = to;
        listener();
      },
    };
    return h;
  }

  it("fires every threshold on the first scroll of a page no taller than its viewport", () => {
    const h = host(800, 0);
    const fired: number[] = [];
    watchScroll(h, new ErrorBoundary(() => undefined, 1), (t) => fired.push(t));

    h.fire();

    expect(fired).toEqual([...SCROLL_THRESHOLDS]);
  });

  it("starts the count over when reset", () => {
    const h = host(PAGE_HEIGHT, 0);
    const fired: number[] = [];
    const reset = watchScroll(h, new ErrorBoundary(() => undefined, 1), (t) => fired.push(t));

    h.move(at(50));
    reset();
    h.move(at(50));

    expect(fired).toEqual([25, 50, 25, 50]);
  });
});

describe("scrollDepth", () => {
  it("is the viewport's bottom edge in percent of the page's height, 0 for a page with none", () => {
    const page = (height: number, y: number): ScrollHost => ({
      document: { documentElement: { scrollHeight: height } },
      scrollY: y,
      innerHeight: VIEWPORT,
      addEventListener: () => undefined,
    });

    expect(scrollDepth(page(PAGE_HEIGHT, 0))).toBe(20);
    expect(scrollDepth(page(PAGE_HEIGHT, 1500))).toBe(50);
    expect(scrollDepth(page(PAGE_HEIGHT, 4000))).toBe(100);
    expect(scrollDepth(page(0, 0))).toBe(0);
  });
});
