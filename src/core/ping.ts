// Anonymous pings (AAI-87): what a site in declined mode `pings` sends instead of an event, once its
// visitor declined. A ping carries only the frozen field list of schema/v1/ping.json (08 G2): the
// site, the event's type, the page's path, the referrer's hostname and the page URL's UTM
// parameters. The collector adds the server-derived fields (country, device class, server
// timestamp; AAI-793). Nothing in a ping links it to another: no visitor or session id, no seq, no
// client time, no language, no props and no purchase (order_id, revenue).
//
// Click IDs (AAI-801) go only on the pings of a site that turned on
// consent.pings_include_click_ids (config.ts, pingsIncludeClickIds; default off): a gclid on a ping
// is how consent-mode-style modelling works, but it makes the ping click-linkable, which the site's
// owner must accept. They are read from the page URL, as the UTMs are, never from the item's own
// attribution.
//
// pingOf reads only the fields it needs from what the consent machine hands its sink's
// `anonymous`, so whatever else the item holds never reaches the ping; buildPing then keeps the
// result to the schema's field list and rules whatever it is given.

import type { ClickIds, Utm, WirePing } from "../wire/generated";
import { buildPing, pingId, type PingInput } from "../wire/payload";
import { CLICK_ID_PARAMS } from "./attribution";

/** What a ping is made from: an item the tag collects, such as a pageview (PageviewInput). */
export interface PingSource {
  readonly type: string;
  readonly site_id: string;
  /** The page's full URL, from which the path and the UTM parameters are read. */
  readonly url: string;
  /** The referrer's full URL, from which only the hostname is read. */
  readonly referrer?: string;
}

/** The UTM parameters a ping carries, by their field in ping.json's Utm: utm_<field> in the URL. */
export const UTM_FIELDS: readonly (keyof Utm)[] = ["source", "medium", "campaign", "term", "content"];

/** "<email>": what an email address in a ping's path becomes, as in a tag error's message. */
const EMAIL_IN_PATH = /[^/@]+(?:@|%40)[^/@]+\.[^/]+/gi;

/**
 * The page's path as a ping carries it: no query string and no fragment (URL.pathname), and each
 * email address in it, plain or percent-encoded, replaced by "<email>", since a visitor who declined
 * must not send one from a path such as /users/jane@example.com.
 */
export function pingPath(url: URL): string {
  return url.pathname.replace(EMAIL_IN_PATH, "<email>");
}

/**
 * The referrer's hostname, undefined when there is no referrer or it isn't a URL with a host. The
 * hostname alone: never its scheme, port, path, query or fragment.
 */
export function referrerHost(referrer: string | undefined): string | undefined {
  if (referrer === undefined || referrer === "") return undefined;
  let url: URL;
  try {
    url = new URL(referrer);
  } catch (error) {
    // Not a URL at all: it has no hostname to send, and the ping goes without one.
    if (error instanceof TypeError) return undefined;
    throw error;
  }
  return url.hostname === "" ? undefined : url.hostname;
}

/** The UTM parameters in the URL's query, those present and not empty; undefined when none is. */
export function utmOf(url: URL): Utm | undefined {
  const utm: Utm = {};
  let found = false;
  for (const field of UTM_FIELDS) {
    const value = url.searchParams.get(`utm_${field}`);
    if (value !== null && value !== "") {
      utm[field] = value;
      found = true;
    }
  }
  return found ? utm : undefined;
}

/** The click IDs in the URL's query, those present and not empty; undefined when none is. */
export function clickIdsOf(url: URL): ClickIds | undefined {
  const clickIds: ClickIds = {};
  let found = false;
  for (const name of CLICK_ID_PARAMS) {
    const value = url.searchParams.get(name);
    if (value !== null && value !== "") {
      clickIds[name] = value;
      found = true;
    }
  }
  return found ? clickIds : undefined;
}

/** How a site's pings are made, from its config. */
export interface PingOptions {
  /** The site's consent.pings_include_click_ids (pingsIncludeClickIds): off when not given. */
  readonly clickIds?: boolean;
}

/**
 * A ping's input from an item: its site and type, its URL's scrubbed path (pingPath) and UTM
 * parameters (utmOf), its referrer's hostname (referrerHost) and, only when options.clickIds is on,
 * its URL's click IDs (clickIdsOf). Throws TypeError when the item's url isn't an absolute URL.
 */
export function pingInput(item: PingSource, options: PingOptions = {}): PingInput {
  const url = new URL(item.url);
  const input: PingInput = { site_id: item.site_id, type: item.type, path: pingPath(url) };
  const host = referrerHost(item.referrer);
  if (host !== undefined) input.referrer_host = host;
  const utm = utmOf(url);
  if (utm !== undefined) input.utm = utm;
  if (options.clickIds === true) {
    const clickIds = clickIdsOf(url);
    if (clickIds !== undefined) input.click_ids = clickIds;
  }
  return input;
}

/**
 * The anonymous ping of an item (pingInput), built to the schema's frozen field list (buildPing).
 * Throws TypeError on an item whose url isn't an absolute URL, and WirePayloadError on one buildPing
 * refuses (a path that isn't a URL path, such as an about:blank page's).
 */
export function pingOf(item: PingSource, eventId: string = pingId(), options: PingOptions = {}): WirePing {
  return buildPing(pingInput(item, options), eventId);
}
