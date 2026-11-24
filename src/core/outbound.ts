// Autocapture of outbound link clicks (01 §4): a click_outbound for each click, or middle click, on
// an http: or https: link whose host is none of the site's own, carrying in link_host the link's
// hostname and nothing else of it: never its path, query, fragment, port or full URL, which can
// hold what the visitor was doing there (an order number, a search, a token).
//
// The site's own hosts are the page's hostname and the config's domains (config.ts, ownDomains),
// each with its subdomains: on shop.example.com with domains ["example.de"], links to
// shop.example.com, cdn.shop.example.com, example.de and www.example.de are internal and ignored. A
// link is found and its href read as a click_special's is (special-clicks.ts, watchLinkClicks), and
// resolved against the document's base URL (a <base href>'s, or else the page's), as the browser
// follows it (AAI-1231). A link of another scheme (tel:,
// mailto:, javascript:) is no outbound click.
//
// The per-site toggle is the config's features.outbound_clicks_enabled, on when absent (boot.ts).

import { TRACKED_EVENT_MAX_LENGTH, TRACKED_EVENT_PATTERN } from "../wire/generated";
import { warn, type ErrorBoundary } from "./boundary";
import { trimDot } from "./config";
import { pageviewInput, type PageSource, type PageviewInput } from "./pageview";
import { watchLinkClicks, type SpecialClickHost } from "./special-clicks";

/** A click_outbound's page fields, as pageviewInput reads them, and its link's hostname. */
export interface ClickOutboundInput extends Omit<PageviewInput, "type" | "referrer" | "attribution"> {
  readonly type: "click_outbound";
  readonly link_host: string;
}

/** What the outbound-click watcher listens on and reads: window, or a stand-in for it in tests. */
export interface OutboundClickHost extends SpecialClickHost {
  /** The document's base URL (a <base href>'s, or else the page's), which a link's href is relative to. */
  readonly document: SpecialClickHost["document"] & { readonly baseURI: string };
  readonly location: { readonly href: string };
}

/** The schemes a link leaves the site by. */
const WEB_SCHEMES = ["http:", "https:"];

/** A link's hostname as the wire schema's LinkHost takes it. */
const LINK_HOST_PATTERN = new RegExp(TRACKED_EVENT_PATTERN.link_host);

/** Whether host is domain or one of its subdomains. */
export function within(host: string, domain: string): boolean {
  return host === domain || host.slice(-domain.length - 1) === `.${domain}`;
}

/**
 * The http: or https: URL a link to href leads to, resolved against the document's base URL baseUrl
 * as the browser follows it; undefined for a malformed href or another scheme.
 */
export function followedUrl(href: string, baseUrl: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(href, baseUrl);
  } catch (error) {
    // A malformed href goes nowhere when clicked.
    if (!(error instanceof TypeError)) throw error;
    return undefined;
  }
  return WEB_SCHEMES.indexOf(url.protocol) < 0 ? undefined : url;
}

/**
 * The hostname of the link href leaves the site by, resolved against the document's base URL
 * baseUrl: lower case, without a trailing dot. Undefined when href is no http: or https: URL, or when
 * its host is that of the page on pageUrl, or one of domains (as ownDomains reads them), or a
 * subdomain of any of them.
 */
export function outboundHost(href: string, baseUrl: string, pageUrl: string, domains: readonly string[]): string | undefined {
  const url = followedUrl(href, baseUrl);
  if (!url) return undefined;
  const host = trimDot(url.hostname);
  const own = [trimDot(new URL(pageUrl).hostname), ...domains];
  for (const domain of own) if (within(host, domain)) return undefined;
  return host;
}

/** The click_outbound of the page as it is now, for a link to host; empty fields are left out. */
export function clickOutboundInput(page: PageSource, site: string, tagVersion: string, host: string, now: number = Date.now()): ClickOutboundInput {
  // A pageview's own fields stay with it: the click_outbound's type replaces its type.
  const { type, referrer, attribution, ...fields } = pageviewInput(page, site, tagVersion, "", now);
  return { ...fields, type: "click_outbound", link_host: host };
}

/**
 * Calls onClick with the hostname of each outbound link the visitor clicks or middle-clicks, as the
 * file's header says. The listeners run inside the boundary, as stage "pageview": a click_outbound
 * belongs to the page's view, as a click_special does. A host the wire schema can't carry (one of
 * the rare characters a URL parser lets through, or over 253 characters) is left out, with a console
 * warning: cutting or mending it would send another host.
 */
export function watchOutboundClicks(
  win: OutboundClickHost,
  boundary: ErrorBoundary,
  domains: readonly string[],
  onClick: (host: string) => void,
): void {
  watchLinkClicks(win, boundary, (href) => {
    const host = outboundHost(href, win.document.baseURI, win.location.href, domains);
    if (host === undefined) return;
    if (host.length > TRACKED_EVENT_MAX_LENGTH.link_host || !LINK_HOST_PATTERN.test(host)) {
      warn("amanda: an outbound link's host is not one the wire schema takes; its click is not sent");
      return;
    }
    onClick(host);
  });
}
