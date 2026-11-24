// The cross-domain linker (AAI-218; 01 §3): carries the visitor's ids from one of the site's
// verified same-owner domains to another, so that one visitor crossing the site's own domains is
// counted once. The set is the config's linker.domains (config.ts, linkerDomains), which the control
// plane publishes from the site's DNS-verified domains, and only while the site's badge-gated
// linker setting is on (AAI-789); a config that lists none turns the linker off.
//
// Decorating: when the visitor clicks, or middle-clicks, an http: or https: link from a page on a
// domain of the set to a host on another domain of the set, the link's href gets LINKER_PARAM
// (identity.ts), `v1.<visitor id>.<session id>.<ms>`, the time it was decorated. Only under granted
// analytics: the ids come from the feed's identified path, and with any other consent state the link
// is left as it is. A link to a host outside the set, or to one under the same listed domain as the
// page, which shares its cookies, is never decorated. The link is found as a click_special's is
// (special-clicks.ts, watchLinkClicks), and its href is rewritten as written, the parameter added
// (or replaced) and nothing else of it changed. A decorated link keeps its href, so a click that
// doesn't decorate (the visitor withdrew since, or the link leads off the set) takes the parameter
// out of the link the visitor follows instead (AAI-1228): a withdrawn visitor's ids never go on, to
// a domain whose consent was granted separately, from a link decorated before the withdrawal.
//
// Adopting: on a landing whose URL holds the parameter, on a page of the set, the ids are adopted
// (identity.ts, adopt) when the value is one this version writes, decorated within the last
// LINKER_MAX_AGE_MS: a decorated URL that is shared, bookmarked or reloaded later carries no one's
// identity to someone else. Adopted ids are written only when the first event goes under granted
// consent; a decline drops them. The parameter is then taken out of the address bar
// (history.replaceState) on every landing that holds it, the linker on or off, so that the page's
// own links, a copied URL and the next page's referrer don't carry it on; and no url or referrer the
// tag sends ever holds it (pageview.ts).

import { TRACKED_EVENT_PATTERN } from "../wire/generated";
import { stripParams } from "./attribution";
import type { ErrorBoundary } from "./boundary";
import { trimDot } from "./config";
import { COOKIE_VERSION, LINKER_PARAM, LINKER_PARAMS, type Ids } from "./identity";
import { within } from "./outbound";
import { watchLinkClicks, type SpecialClickHost } from "./special-clicks";

/** How long a decorated link carries the ids: two minutes after the click that decorated it. */
export const LINKER_MAX_AGE_MS = 2 * 60 * 1000;

const UUID7 = TRACKED_EVENT_PATTERN.visitor_id.slice(1, -1);
const VALUE = new RegExp(`^${COOKIE_VERSION}\\.(${UUID7})\\.(${UUID7})\\.(\\d{1,15})$`);

/** The visitor's ids as the linker reads and adopts them: the feed's, under its consent machine. */
export interface LinkerIdentity {
  /** The visitor's ids for a link decorated now, under granted analytics only; otherwise undefined. */
  ids(): Ids | undefined;
  /** Takes ids the linker brought as the visitor's (identity.ts, adopt). */
  adopt(ids: Ids): void;
}

/** What the linker reads, listens on and rewrites: window, or a stand-in for it in tests. */
export interface LinkerHost extends SpecialClickHost {
  readonly location: { readonly href: string };
  readonly history: Pick<History, "state" | "replaceState">;
  readonly Element: SpecialClickHost["Element"] & { readonly prototype: Pick<Element, "setAttribute"> };
}

/** The parameter's value for ids, decorated at now. */
export function linkerValue(ids: Ids, now: number): string {
  return `${COOKIE_VERSION}.${ids.visitorId}.${ids.sessionId}.${Math.floor(now)}`;
}

/**
 * The ids a parameter's value carries, when it is one linkerValue writes, decorated no more than
 * LINKER_MAX_AGE_MS from now either way; otherwise undefined.
 */
export function linkedIds(value: string, now: number): Ids | undefined {
  const match = VALUE.exec(value);
  if (!match || Math.abs(now - Number(match[3])) > LINKER_MAX_AGE_MS) return undefined;
  return { visitorId: match[1]!, sessionId: match[2]! };
}

/** The domains of the set host is on: each it is, or is a subdomain of. */
function domainsOf(host: string, domains: readonly string[]): string[] {
  const name = trimDot(host);
  return domains.filter((domain) => within(name, domain));
}

/**
 * Whether a link to href, resolved against the page's URL pageUrl, carries the ids: when it is an
 * http: or https: URL whose host is on a domain of the set, the page's host is on one too, and no
 * domain of the set has both, which would share the cookies already.
 */
export function linksAcross(href: string, pageUrl: string, domains: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(href, pageUrl);
  } catch (error) {
    // A malformed href goes nowhere when clicked.
    if (!(error instanceof TypeError)) throw error;
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const to = domainsOf(url.hostname, domains);
  const from = domainsOf(new URL(pageUrl).hostname, domains);
  return to.length > 0 && from.length > 0 && !to.some((domain) => from.indexOf(domain) >= 0);
}

/** href, as written, with LINKER_PARAM set to value: added to its query, before its fragment. */
export function decorate(href: string, value: string): string {
  const clean = stripParams(href, LINKER_PARAMS);
  const hash = clean.indexOf("#");
  const end = hash < 0 ? clean.length : hash;
  const query = clean.indexOf("?");
  const separator = query < 0 || query > end ? "?" : query === end - 1 ? "" : "&";
  return `${clean.slice(0, end)}${separator}${LINKER_PARAM}=${value}${clean.slice(end)}`;
}

/**
 * Starts the linker on win's page, as the file's header says: adopts the landing URL's linked ids
 * and takes the parameter out of the address bar, then, while domains lists any, decorates the links
 * the visitor follows to the set's other domains. Call it before the page's first event.
 */
export function startLinker(
  win: LinkerHost,
  boundary: ErrorBoundary,
  domains: readonly string[],
  identity: LinkerIdentity,
  now: () => number,
): void {
  const href = win.location.href;
  const value = new URL(href).searchParams.get(LINKER_PARAM);
  if (value !== null) {
    const linked = domainsOf(new URL(href).hostname, domains).length > 0 ? linkedIds(value, now()) : undefined;
    if (linked) identity.adopt(linked);
    win.history.replaceState(win.history.state, "", stripParams(href, LINKER_PARAMS));
  }
  if (domains.length === 0) return;
  watchLinkClicks(win, boundary, (link, element) => {
    const ids = linksAcross(link, win.location.href, domains) ? identity.ids() : undefined;
    const rewritten = ids ? decorate(link, linkerValue(ids, now())) : stripParams(link, LINKER_PARAMS);
    if (rewritten !== link) win.Element.prototype.setAttribute.call(element, "href", rewritten);
  });
}
