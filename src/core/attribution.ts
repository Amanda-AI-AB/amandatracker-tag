// Attribution capture (AAI-99): on each landing, the page load's first pageview, the tag reads the
// landing URL's query string for the UTM set, the ad platforms' click IDs and the site's own
// parameters (its config's custom_params), and the pageview carries them as its attribution
// (event.json's Attribution). A route change of a single-page app is not a landing, and carries none.
//
// Values go verbatim, as URLSearchParams decodes them: no case normalisation, so that Summer and
// summer stay distinct, and no classification, which is the processor's (AAI-102). The collector
// caps each value at 200 characters (03 §5).
//
// Click IDs are identifiers, and go only while ads consent isn't denied: under denied ads
// (gateClickIds) an event loses its click_ids, and its url and referrer lose their click-ID
// parameters too, which would carry the same IDs. UTMs and custom parameters are campaign labels,
// not identifiers, and still go.

import {
  ATTRIBUTION_UTM_FIELDS,
  CLICK_IDS_FIELDS,
  type Attribution,
  type AttributionUtm,
  type ClickIds,
  type Consent,
  type CustomParams,
} from "../wire/generated";

/** The click-ID parameters the tag captures, by their names in the URL (01 §5, M1's set). */
export const CLICK_ID_PARAMS: readonly (keyof ClickIds)[] = CLICK_IDS_FIELDS;

/** The UTM parameter of each field of the UTM set: utm_<field>. */
export function utmParam(field: keyof AttributionUtm): string {
  return `utm_${field}`;
}

/** What an item carries that attribution and its ads gate touch: a pageview (PageviewInput). */
export interface Attributed {
  readonly url: string;
  readonly referrer?: string;
  readonly attribution?: Attribution;
}

/**
 * The attribution in href's query string: each UTM, click ID and custom parameter present and not
 * empty, the first one where a parameter repeats; undefined when there is none. A custom parameter
 * that is a UTM or a click ID is left to its own field, so that the ads gate can't miss it. Throws
 * TypeError when href isn't an absolute URL.
 */
export function attributionOf(href: string, custom: readonly string[]): Attribution | undefined {
  const params = new URL(href).searchParams;
  const read = (name: string): string | undefined => {
    const value = params.get(name);
    return value === null || value === "" ? undefined : value;
  };
  const attribution: Attribution = {};
  const utm: AttributionUtm = {};
  for (const field of ATTRIBUTION_UTM_FIELDS) {
    const value = read(utmParam(field));
    if (value !== undefined) utm[field] = value;
  }
  if (Object.keys(utm).length > 0) attribution.utm = utm;
  const clickIds: ClickIds = {};
  for (const name of CLICK_ID_PARAMS) {
    const value = read(name);
    if (value !== undefined) clickIds[name] = value;
  }
  if (Object.keys(clickIds).length > 0) attribution.click_ids = clickIds;
  const own: CustomParams = {};
  for (const name of custom) {
    if (isUtmOrClickId(name)) continue;
    const value = read(name);
    if (value !== undefined) own[name] = value;
  }
  if (Object.keys(own).length > 0) attribution.custom = own;
  return Object.keys(attribution).length > 0 ? attribution : undefined;
}

function isUtmOrClickId(name: string): boolean {
  if ((CLICK_ID_PARAMS as readonly string[]).indexOf(name) >= 0) return true;
  for (const field of ATTRIBUTION_UTM_FIELDS) if (utmParam(field) === name) return true;
  return false;
}

/** A query pair's name, decoded as URLSearchParams decodes it; as written when it can't be. */
function paramName(pair: string): string {
  const eq = pair.indexOf("=");
  const raw = (eq < 0 ? pair : pair.slice(0, eq)).replace(/\+/g, " ");
  try {
    return decodeURIComponent(raw);
  } catch (error) {
    // A malformed escape (a lone "%"): the name is compared as it is written.
    if (error instanceof URIError) return raw;
    throw error;
  }
}

/**
 * href without the query parameters names lists, every other part of it, the remaining pairs
 * included, left exactly as written: rebuilding the query with URLSearchParams would re-encode it.
 */
export function stripParams(href: string, names: readonly string[]): string {
  const hash = href.indexOf("#");
  const end = hash < 0 ? href.length : hash;
  const query = href.indexOf("?");
  if (query < 0 || query > end) return href;
  const pairs = href.slice(query + 1, end).split("&");
  const kept = pairs.filter((pair) => names.indexOf(paramName(pair)) < 0);
  if (kept.length === pairs.length) return href;
  return href.slice(0, query) + (kept.length > 0 ? `?${kept.join("&")}` : "") + href.slice(end);
}

/**
 * item as an event under consent may carry it: whole while ads isn't denied; under denied ads,
 * without its click_ids, and with the click-ID parameters dropped from its url and referrer. Call
 * it on the consent machine's identified path, with the snapshot the event carries, before the
 * event is built.
 */
export function gateClickIds<T extends Attributed>(item: T, consent: Consent): T {
  if (consent.ads !== "denied") return item;
  const gated: { -readonly [K in keyof Attributed]: Attributed[K] } = { ...item, url: stripParams(item.url, CLICK_ID_PARAMS) };
  if (item.referrer !== undefined) gated.referrer = stripParams(item.referrer, CLICK_ID_PARAMS);
  if (item.attribution !== undefined && item.attribution.click_ids !== undefined) {
    const labels: Attribution = { ...item.attribution };
    delete labels.click_ids;
    if (Object.keys(labels).length > 0) gated.attribution = labels;
    else delete gated.attribution;
  }
  // gated is item with only url, referrer and attribution changed, each to a value of its type.
  return gated as T;
}
