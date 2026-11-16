// Autocapture of scroll depth (01 §4): a scroll event the first time, in each pageview, the visitor
// has scrolled to 25, 50, 75 and 90 % of the page's height, its props holding that threshold as
// percent_scrolled (GA4's name for it). It is off by default: data minimisation has every new field
// start at "not collected", so the tag measures nothing unless its boot is handed onScrollDepth.
// a.js doesn't hand it over yet: the per-site toggle that turns it on, scroll_enabled in the site's
// config, is AAI-791's.
//
// The depth is how far down the page the viewport's bottom edge is: scrollY plus innerHeight, out of
// the document's scrollHeight. It is measured on the window's scroll events only, so a page that
// fits its viewport, which the visitor never scrolls, sends none. One scroll that passes several
// thresholds sends one event for each, in ascending order. A route change starts a new pageview,
// whose thresholds fire again.
//
// Nothing is read from the page but those three numbers: no element, position or text.

import type { ErrorBoundary } from "./boundary";
import { pageviewInput, type PageSource, type PageviewInput } from "./pageview";

/** The depths, in percent of the page's height, that each send a scroll event once per pageview. */
export const SCROLL_THRESHOLDS: readonly number[] = [25, 50, 75, 90];

/** The props a scroll event carries. A type, not an interface, so that it is assignable to the wire's Props map. */
export type ScrollDepthProps = {
  readonly percent_scrolled: number;
};

/** A scroll event's page fields, as pageviewInput reads them, and the threshold it crossed. */
export interface ScrollDepthInput extends Omit<PageviewInput, "type" | "referrer" | "attribution"> {
  readonly type: "scroll";
  readonly props: ScrollDepthProps;
}

/** What the scroll watcher reads and listens on: window, or a stand-in for it in tests. */
export interface ScrollHost {
  readonly document: { readonly documentElement: { readonly scrollHeight: number } };
  readonly scrollY: number;
  readonly innerHeight: number;
  addEventListener(type: "scroll", listener: () => void): void;
}

/**
 * How far down win's page the viewport's bottom edge is, in percent of the page's height; 0 for a
 * page with no height.
 */
export function scrollDepth(win: ScrollHost): number {
  const height = win.document.documentElement.scrollHeight;
  if (!(height > 0)) return 0;
  return ((win.scrollY + win.innerHeight) / height) * 100;
}

/** The scroll event of the page as it is now, for threshold; empty fields are left out. */
export function scrollDepthInput(
  page: PageSource,
  site: string,
  tagVersion: string,
  threshold: number,
  now: number = Date.now(),
): ScrollDepthInput {
  // A pageview's own fields stay with it: the scroll event's type replaces its type.
  const { type, referrer, attribution, ...fields } = pageviewInput(page, site, tagVersion, "", now);
  return { ...fields, type: "scroll", props: { percent_scrolled: threshold } };
}

/** Starts a new pageview's count: each threshold may fire again. */
export type ScrollReset = () => void;

/**
 * Calls onThreshold with each threshold of SCROLL_THRESHOLDS the visitor scrolls to, once each until
 * the returned reset is called, as the file's header says. The listener runs inside the boundary, as
 * stage "pageview": a scroll event belongs to the page's view, as a page_exit does.
 */
export function watchScroll(win: ScrollHost, boundary: ErrorBoundary, onThreshold: (threshold: number) => void): ScrollReset {
  /** How many of SCROLL_THRESHOLDS this pageview has fired: they fire in order, so a count is enough. */
  let fired = 0;
  win.addEventListener("scroll", () =>
    boundary.guard("pageview", () => {
      const depth = scrollDepth(win);
      while (fired < SCROLL_THRESHOLDS.length && depth >= SCROLL_THRESHOLDS[fired]!) {
        // Counted before it is handed over, so a failure downstream never sends it twice.
        fired += 1;
        onThreshold(SCROLL_THRESHOLDS[fired - 1]!);
      }
    }),
  );
  return () => {
    fired = 0;
  };
}
