// Pageviews: one when the tag boots, and one on each route change of a single-page app, which the
// tag sees by wrapping history.pushState and history.replaceState and by listening for popstate.
// A route change is a change of the URL without its fragment: the event's url drops the fragment
// anyway (src/wire/payload.ts), so a hash-only change would send the same page twice.

import { stripFrom } from "../wire/payload";
import type { ErrorBoundary } from "./boundary";

/**
 * A pageview's page fields, as the tag knows them at the time. The transport (AAI-68), identity
 * (AAI-98) and consent (AAI-84) add the event_id, the visitor and session ids and the consent
 * snapshot, and the payload builder (buildEvent) shapes the whole to the wire schema.
 */
export interface PageviewInput {
  readonly type: "pageview";
  readonly site_id: string;
  readonly tag_version: string;
  readonly client_ts: number;
  readonly url: string;
  readonly referrer?: string;
  readonly page_title?: string;
  readonly language?: string;
}

/** What a pageview reads from the page. */
export interface PageSource {
  readonly location: { readonly href: string };
  readonly document: { readonly title: string; readonly referrer: string };
  readonly navigator: { readonly language?: string };
}

/**
 * The pageview of the page as it is now; `referrer` is document.referrer for the first one and the
 * previous URL for a route change. Empty fields are left out.
 */
export function pageviewInput(
  page: PageSource,
  site: string,
  tagVersion: string,
  referrer: string,
  now: number = Date.now(),
): PageviewInput {
  const input: { -readonly [K in keyof PageviewInput]: PageviewInput[K] } = {
    type: "pageview",
    site_id: site,
    tag_version: tagVersion,
    client_ts: Math.floor(now),
    url: page.location.href,
  };
  if (referrer !== "") input.referrer = referrer;
  if (page.document.title !== "") input.page_title = page.document.title;
  const language = page.navigator.language;
  if (language) input.language = language;
  return input;
}

/** href without its fragment: what tells one route from another. */
export function routeOf(href: string): string {
  return stripFrom(href, "#");
}

/** What watchRoutes patches and listens on. */
export interface RouteSource {
  readonly location: { readonly href: string };
  readonly history: History;
  addEventListener(type: "popstate", listener: () => void): void;
}

type HistoryMethod = "pushState" | "replaceState";

/**
 * Calls onChange each time the route changes: after history.pushState or history.replaceState, and
 * on popstate (back and forward). The wrapped methods call the page's own with its arguments and
 * return what it returns; what that throws is the page's and goes to it unchanged. onChange runs
 * inside the boundary, after the page's call.
 */
export function watchRoutes(win: RouteSource, boundary: ErrorBoundary, onChange: () => void): void {
  let current = routeOf(win.location.href);
  const check = (): void => {
    boundary.guard("route", () => {
      const next = routeOf(win.location.href);
      if (next === current) return;
      current = next;
      onChange();
    });
  };
  const wrap = (method: HistoryMethod): void => {
    const history = win.history;
    const original = history[method];
    if (typeof original !== "function") return;
    history[method] = function (this: History, ...args: Parameters<History[HistoryMethod]>) {
      const result = original.apply(this, args);
      check();
      return result;
    };
  };
  wrap("pushState");
  wrap("replaceState");
  win.addEventListener("popstate", check);
}
