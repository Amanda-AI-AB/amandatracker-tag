// Engagement time and page_exit (01 §7.1). Engagement time is GA4-like: the time the page is
// visible, each span of it counted up to ENGAGEMENT_DECAY_MS after the visitor's last interaction,
// or after the page loaded or was shown again. A hidden tab pauses the clock, and so do 15 s
// without interaction; the next interaction starts it again.
//
// Each time the page is hidden (visibilitychange to hidden, or pagehide, the last moment a mobile
// browser reliably gives a page), the tag hands over a page_exit with the engagement time since the
// previous one, so the processor can add them up (AAI-798) and a tab switched back and forth counts
// each visible span once. A hide with no engagement since the previous page_exit sends nothing,
// except the page load's first, so every page load the visitor leaves sends at least one: the
// tail-loss proxy counts them (AAI-648). The transport sends a page_exit at once, by beacon
// (transport.ts), since a hidden page may never run a timer again.
//
// Everything is in memory, and nothing is read from the page but its visibility and the
// interactions' times: no target, key or coordinate.

import type { ErrorBoundary } from "./boundary";
import { pageviewInput, type PageSource, type PageviewInput } from "./pageview";

/** How long after an interaction the clock keeps running without another. */
export const ENGAGEMENT_DECAY_MS = 15_000;

/** The events that count as an interaction, listened for on the document in the capture phase. */
export const INTERACTIONS: readonly string[] = ["pointerdown", "pointermove", "keydown", "touchstart", "wheel", "scroll"];

/** The engagement clock, driven with the time of each change. */
export interface EngagementClock {
  /** The visitor interacted: a visible page's clock runs, for ENGAGEMENT_DECAY_MS from now. */
  interaction(now: number): void;
  /** The page was hidden: the clock stops until it is shown again. */
  hidden(now: number): void;
  /** The page was shown: the clock runs, as after an interaction. */
  shown(now: number): void;
  /** The engagement time since the previous take, in whole milliseconds. */
  take(now: number): number;
}

/** A clock for a page that is visible or not now; a visible page's clock starts running at once. */
export function createEngagementClock(visible: boolean, now: number): EngagementClock {
  let shown = false;
  let accrued = 0;
  /** When the running span started; undefined while the clock is paused. */
  let start: number | undefined;
  /** When the running span ends without another interaction. */
  let deadline = 0;

  /** Adds the running span up to now to accrued, and stops the clock if its deadline passed. */
  const settle = (now: number): void => {
    if (start === undefined) return;
    // max: a clock set back must not take time away.
    accrued += Math.max(0, Math.min(now, deadline) - start);
    start = now < deadline ? now : undefined;
  };

  const clock: EngagementClock = {
    interaction(now) {
      if (!shown) return;
      settle(now);
      if (start === undefined) start = now;
      deadline = now + ENGAGEMENT_DECAY_MS;
    },
    hidden(now) {
      settle(now);
      start = undefined;
      shown = false;
    },
    shown(now) {
      shown = true;
      clock.interaction(now);
    },
    take(now) {
      settle(now);
      const whole = Math.floor(accrued);
      accrued -= whole;
      return whole;
    },
  };
  if (visible) clock.shown(now);
  return clock;
}

/** What the engagement watcher listens on: window, or a stand-in for it in tests. */
export interface EngagementHost {
  readonly document: {
    readonly visibilityState: DocumentVisibilityState;
    addEventListener(type: string, listener: () => void, options?: AddEventListenerOptions): void;
  };
  addEventListener(type: "pagehide" | "pageshow", listener: () => void): void;
}

/**
 * Runs the engagement clock on win's visibility and interactions, and calls onExit with the
 * engagement time each time the page is hidden, as the file's header says. Every listener runs
 * inside the boundary, as stage "pageview": a page_exit belongs to the page's view.
 */
export function watchEngagement(
  win: EngagementHost,
  boundary: ErrorBoundary,
  onExit: (engagementMs: number) => void,
  now: () => number = Date.now,
): void {
  const visible = (): boolean => win.document.visibilityState === "visible";
  const clock = createEngagementClock(visible(), now());
  let exited = false;

  const exit = (): void => {
    const at = now();
    clock.hidden(at);
    const engaged = clock.take(at);
    if (engaged === 0 && exited) return;
    exited = true;
    onExit(engaged);
  };

  const guarded =
    (listener: () => void): (() => void) =>
    () =>
      boundary.guard("pageview", listener);
  const interaction = guarded(() => clock.interaction(now()));
  const options: AddEventListenerOptions = { capture: true, passive: true };
  for (const type of INTERACTIONS) win.document.addEventListener(type, interaction, options);
  win.document.addEventListener(
    "visibilitychange",
    guarded(() => (visible() ? clock.shown(now()) : exit())),
  );
  win.addEventListener("pagehide", guarded(exit));
  // A page restored from the back/forward cache is shown again.
  win.addEventListener(
    "pageshow",
    guarded(() => {
      if (visible()) clock.shown(now());
    }),
  );
}

/** A page_exit's page fields, as pageviewInput reads them, and its engagement time. */
export interface PageExitInput extends Omit<PageviewInput, "type" | "referrer" | "attribution"> {
  readonly type: "page_exit";
  readonly engagement_ms: number;
}

/** The page_exit of the page as it is now, with engagementMs; empty fields are left out. */
export function pageExitInput(
  page: PageSource,
  site: string,
  tagVersion: string,
  engagementMs: number,
  now: number = Date.now(),
): PageExitInput {
  // A pageview's own fields stay with it: the page_exit's type replaces its type.
  const { type, referrer, attribution, ...fields } = pageviewInput(page, site, tagVersion, "", now);
  return { ...fields, type: "page_exit", engagement_ms: engagementMs };
}
