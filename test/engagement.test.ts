import { describe, expect, it } from "vitest";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import {
  createEngagementClock,
  ENGAGEMENT_DECAY_MS,
  INTERACTIONS,
  pageExitInput,
  watchEngagement,
  type EngagementHost,
} from "../src/core/engagement";
import { buildEvent } from "../src/wire/payload";
import { validator } from "./wire-validator";

const S = 1000;
const DECAY = ENGAGEMENT_DECAY_MS;

describe("engagement clock", () => {
  it("decays 15 s after its last interaction", () => {
    expect(DECAY).toBe(15 * S);
  });

  it("counts a visible page from its load, up to 15 s without an interaction", () => {
    const clock = createEngagementClock(true, 0);
    expect(clock.take(10 * S)).toBe(10 * S);
    expect(clock.take(60 * S)).toBe(5 * S);
  });

  it("counts nothing for a page loaded in a background tab until it is shown", () => {
    const clock = createEngagementClock(false, 0);
    clock.interaction(5 * S);
    expect(clock.take(30 * S)).toBe(0);
    clock.shown(30 * S);
    expect(clock.take(40 * S)).toBe(10 * S);
  });

  it("keeps running while the visitor interacts, and pauses 15 s after the last interaction", () => {
    const clock = createEngagementClock(true, 0);
    for (let t = 10 * S; t <= 60 * S; t += 10 * S) clock.interaction(t);
    // Engaged from 0 to the last interaction at 60 s, plus 15 s of decay.
    expect(clock.take(5 * 60 * S)).toBe(75 * S);
  });

  it("starts again on the first interaction after an idle period, never counting the idle time", () => {
    const clock = createEngagementClock(true, 0);
    // 0 to 15 s engaged, idle from 15 s to 100 s, then 100 s to 108 s engaged.
    clock.interaction(100 * S);
    expect(clock.take(108 * S)).toBe(15 * S + 8 * S);
  });

  it("pauses while the tab is hidden, and runs again when it is shown", () => {
    const clock = createEngagementClock(true, 0);
    clock.interaction(5 * S);
    clock.hidden(8 * S);
    // Hidden: interactions don't count, and neither does time.
    clock.interaction(20 * S);
    expect(clock.take(60 * S)).toBe(8 * S);
    clock.shown(60 * S);
    expect(clock.take(70 * S)).toBe(10 * S);
  });

  it("counts the decay window only up to the hide", () => {
    const clock = createEngagementClock(true, 0);
    clock.interaction(10 * S);
    clock.hidden(12 * S);
    expect(clock.take(100 * S)).toBe(12 * S);
  });

  it("hands back each span once: take gives the time since the previous take", () => {
    const clock = createEngagementClock(true, 0);
    expect(clock.take(4 * S)).toBe(4 * S);
    expect(clock.take(4 * S)).toBe(0);
    expect(clock.take(6 * S)).toBe(2 * S);
  });

  it("gives whole milliseconds, carrying the fractions to the next take", () => {
    const clock = createEngagementClock(true, 0.4);
    expect(clock.take(10.2)).toBe(9);
    expect(clock.take(10.6)).toBe(1);
  });

  it("never counts backwards when the clock is set back", () => {
    const clock = createEngagementClock(true, 10 * S);
    expect(clock.take(5 * S)).toBe(0);
    expect(clock.take(8 * S)).toBe(3 * S);
  });
});

/** A stand-in window: its visibility, its document's and window's listeners, and its clock. */
function page(initial: DocumentVisibilityState = "visible") {
  let time = 0;
  let visibility = initial;
  const docListeners: { type: string; listener: () => void; options?: AddEventListenerOptions }[] = [];
  const winListeners: { type: string; listener: () => void }[] = [];
  const host: EngagementHost = {
    document: {
      get visibilityState() {
        return visibility;
      },
      addEventListener: (type, listener, options) => docListeners.push({ type, listener, ...(options ? { options } : {}) }),
    },
    addEventListener: (type, listener) => winListeners.push({ type, listener }),
  };
  const fire = (list: { type: string; listener: () => void }[], type: string): void => {
    for (const entry of list) if (entry.type === type) entry.listener();
  };
  const reports: ErrorReport[] = [];
  const boundary = new ErrorBoundary((report) => reports.push(report), 1, () => 0);
  const exits: number[] = [];
  return {
    host,
    boundary,
    reports,
    exits,
    docListeners,
    watch: (onExit: (ms: number) => void = (ms) => exits.push(ms)) => watchEngagement(host, boundary, onExit, () => time),
    interact: (t: number, type = "pointerdown") => {
      time = t;
      fire(docListeners, type);
    },
    hide: (t: number) => {
      time = t;
      visibility = "hidden";
      fire(docListeners, "visibilitychange");
    },
    show: (t: number) => {
      time = t;
      visibility = "visible";
      fire(docListeners, "visibilitychange");
    },
    pagehide: (t: number) => {
      time = t;
      fire(winListeners, "pagehide");
    },
    pageshow: (t: number) => {
      time = t;
      fire(winListeners, "pageshow");
    },
  };
}

describe("watchEngagement: page_exit", () => {
  it("sends a page_exit with the engagement time when the tab is hidden", () => {
    const p = page();
    p.watch();
    p.interact(10 * S);
    p.hide(20 * S);
    expect(p.exits).toEqual([20 * S]);
  });

  it("sends one page_exit per hide across tab switches, each with the time since the previous one", () => {
    const p = page();
    p.watch();
    p.hide(10 * S);
    p.show(100 * S);
    p.interact(105 * S);
    p.hide(110 * S);
    p.show(200 * S);
    p.hide(203 * S);
    expect(p.exits).toEqual([10 * S, 10 * S, 3 * S]);
    // The sum is the page's engagement time: the hidden 90 s and 87 s never count.
    expect(p.exits.reduce((a, b) => a + b, 0)).toBe(23 * S);
  });

  it("counts no idle time: 15 s after the last interaction the clock pauses until the next", () => {
    const p = page();
    p.watch();
    p.interact(5 * S);
    // idle from 20 s to 300 s
    p.interact(300 * S, "keydown");
    p.interact(310 * S, "scroll");
    p.hide(400 * S);
    expect(p.exits).toEqual([20 * S + 25 * S]);
  });

  it("sends one page_exit when pagehide follows the hide, as when the visitor closes the tab", () => {
    const p = page();
    p.watch();
    p.hide(7 * S);
    p.pagehide(7 * S);
    expect(p.exits).toEqual([7 * S]);
  });

  it("sends a page_exit on pagehide alone, where the browser fires no visibilitychange", () => {
    const p = page();
    p.watch();
    p.pagehide(4 * S);
    expect(p.exits).toEqual([4 * S]);
  });

  it("sends a page_exit of 0 for a page load never engaged, once: every page load the visitor leaves sends one", () => {
    const p = page("hidden");
    p.watch();
    p.interact(3 * S);
    p.pagehide(9 * S);
    p.pagehide(10 * S);
    expect(p.exits).toEqual([0]);
  });

  it("sends nothing on a later hide with no engagement since the previous page_exit", () => {
    const p = page();
    p.watch();
    p.hide(5 * S);
    p.show(6 * S);
    p.hide(6 * S);
    expect(p.exits).toEqual([5 * S]);
  });

  it("runs the clock again for a page restored from the back/forward cache", () => {
    const p = page();
    p.watch();
    p.pagehide(5 * S);
    p.pageshow(50 * S);
    p.pagehide(58 * S);
    expect(p.exits).toEqual([5 * S, 8 * S]);
  });

  it("listens for interactions on the document, in the capture phase and passively", () => {
    const p = page();
    p.watch();
    const interactions = p.docListeners.filter((entry) => entry.type !== "visibilitychange");
    expect(interactions.map((entry) => entry.type)).toEqual([...INTERACTIONS]);
    for (const entry of interactions) expect(entry.options).toEqual({ capture: true, passive: true });
  });

  it("reports what onExit throws instead of throwing it into the page, and keeps counting", () => {
    const p = page();
    p.watch(() => {
      throw new Error("sink failed");
    });
    expect(() => p.hide(5 * S)).not.toThrow();
    expect(p.reports).toEqual([{ stage: "pageview", name: "Error", message: "sink failed" }]);
  });
});

describe("pageExitInput", () => {
  const source = {
    location: { href: "https://shop.example/products?id=1#reviews" },
    document: { title: "Products", referrer: "https://search.example/" },
    navigator: { language: "sv-SE" },
  };

  it("carries the page as it is now and the engagement time, and neither referrer nor attribution", () => {
    const input = pageExitInput(source, "site_123", "0.2.0", 12_345, 1_731_400_000_000);
    expect(input).toEqual({
      type: "page_exit",
      site_id: "site_123",
      tag_version: "0.2.0",
      client_ts: 1_731_400_000_000,
      url: "https://shop.example/products?id=1#reviews",
      page_title: "Products",
      language: "sv-SE",
      engagement_ms: 12_345,
    });
  });

  it("builds into a valid page_exit event", () => {
    const input = pageExitInput(source, "site_123", "0.2.0", 0, 1_731_400_000_000);
    const event = buildEvent({
      ...input,
      visitor_id: "01934f6c-8d2a-7b3c-8d4e-5f6a7b8c9d01",
      session_id: "01934f6c-8d2a-7b3c-ad4e-5f6a7b8c9d02",
      consent: { analytics: "granted", ads: "granted" },
    });
    const validate = validator("event.json");
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
    expect(event).toMatchObject({ type: "page_exit", engagement_ms: 0, url: "https://shop.example/products?id=1" });
  });
});
