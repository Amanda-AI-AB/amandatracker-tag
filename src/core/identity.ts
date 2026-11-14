// The visitor's identity (AAI-98): two strictly first-party cookies on the site's own registrable
// domain, never on the collection domain.
//
//   _amnda_id   v1.<visitor UUIDv7>                        13 months, rolling
//   _amnda_ses  v1.<session UUIDv7>.<last activity, ms>    30 minutes, rolling
//
// Both are written `Domain=.<etld+1>; Path=/; SameSite=Lax; Secure`. The tag finds the registrable
// domain the way browsers allow it without a public-suffix list: it writes a probe cookie on each
// parent domain, shortest first, and takes the first the browser keeps, as a browser refuses a
// cookie on a public suffix. An IP address or a single-label host such as localhost has no parent
// domain, so its cookies are host-only. When the browser keeps none (a page on http:, cookies
// blocked), the ids live in memory for the page alone, with a warning.
//
// The ids are random UUIDv7s, never derived from anything about the visitor, their IP or their
// device, and each site keeps its own: the cookies live on the site's domain alone.
//
// Consent gates every write. Only the consent machine's identified path (ConsentSink.identified,
// under granted analytics) calls ids(), which mints what is missing, rolls the session and
// refreshes both cookies; nothing else here writes a cookie but renew(), which the machine calls
// only on a grant. forget() deletes both cookies at once, those the collector re-issued through a
// first-party proxy too (AAI-827; it never sets them HttpOnly), and a grant after a denial renews
// both ids, so earlier anonymous pings are never linked to the visitor (consent.ts).
//
// Safari's ITP caps script-written cookies at 7 days, or 24 hours after a link with tracking
// decoration: an accepted limitation. A first-party proxy the customer runs is the documented way
// to keep them their full lifetime (docs/first-party-proxy.md), not a hosted feature.

import { TRACKED_EVENT_PATTERN } from "../wire/generated";
import { uuidv7 } from "../wire/payload";
import { warn } from "./boundary";
import type { IdentityControl } from "./consent";

export const VISITOR_COOKIE = "_amnda_id";
export const SESSION_COOKIE = "_amnda_ses";
/** The cookie the tag probes a domain with, and deletes again at once. */
export const PROBE_COOKIE = "_amnda_probe";
/** The cookies' format version, their values' first part. */
export const COOKIE_VERSION = "v1";

/** The visitor cookie's lifetime: 13 months (CNIL), as 395 days, renewed on each event. */
export const VISITOR_MAX_AGE_S = 395 * 24 * 60 * 60;
/** A session ends after 30 minutes without an event. */
export const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

const UUID7 = new RegExp(TRACKED_EVENT_PATTERN.visitor_id);
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const ATTRIBUTES = "; Path=/; SameSite=Lax; Secure";

/** The globals identity reads: the page's cookies and its URL. */
export interface IdentityHost {
  readonly document: { cookie: string };
  readonly location: Pick<Location, "href">;
}

/** The ids an identified event carries. */
export interface Ids {
  readonly visitorId: string;
  readonly sessionId: string;
}

export interface Identity extends IdentityControl {
  /**
   * The ids for an event happening now, under granted analytics consent only: the visitor's, or a
   * fresh one; the session's while it had an event in the last 30 minutes, or a fresh one. Both
   * cookies are written again, with their lifetimes renewed.
   */
  ids(): Ids;
}

export interface IdentityOptions {
  readonly now?: () => number;
  /** Random bytes for the ids and the probe. */
  readonly random?: (length: number) => Uint8Array;
}

/** A cookie's value from a document.cookie string, or undefined. */
export function readCookie(cookies: string, name: string): string | undefined {
  for (const part of cookies.split(";")) {
    const eq = part.indexOf("=");
    if (eq >= 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** The visitor id an `_amnda_id` value holds, or undefined when it isn't one this version wrote. */
export function parseVisitor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parts = value.split(".");
  return parts.length === 2 && parts[0] === COOKIE_VERSION && UUID7.test(parts[1]!) ? parts[1] : undefined;
}

/** The session an `_amnda_ses` value holds, or undefined when it isn't one this version wrote. */
export function parseSession(value: string | undefined): { id: string; lastActivity: number } | undefined {
  if (value === undefined) return undefined;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== COOKIE_VERSION || !UUID7.test(parts[1]!) || !/^\d{1,15}$/.test(parts[2]!)) {
    return undefined;
  }
  return { id: parts[1]!, lastActivity: Number(parts[2]) };
}

/**
 * The domains a cookie for hostname may go on, shortest first: each parent domain of two labels or
 * more, then hostname itself. An IP address, an IPv6 literal or a single-label host has none: its
 * cookies are host-only, which the one `undefined` entry stands for.
 */
export function candidateDomains(hostname: string): (string | undefined)[] {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const labels = host.split(".");
  if (labels.length < 2 || IPV4.test(host) || host.indexOf(":") >= 0 || host.charAt(0) === "[") return [undefined];
  const domains: string[] = [];
  for (let n = 2; n <= labels.length; n++) domains.push(labels.slice(labels.length - n).join("."));
  return domains;
}

function cookieString(name: string, value: string, maxAge: number, domain: string | undefined): string {
  return `${name}=${value}; Max-Age=${maxAge}${domain === undefined ? "" : `; Domain=.${domain}`}${ATTRIBUTES}`;
}

function defaultRandom(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/**
 * The visitor's identity on host's page. It touches no cookie until the consent machine says so:
 * ids() and renew() under granted consent, forget() on a denial.
 */
export function createIdentity(host: IdentityHost, options: IdentityOptions = {}): Identity {
  const now = options.now ?? Date.now;
  const random = options.random ?? defaultRandom;
  const doc = host.document;
  // The ids as last written; they stand in for the cookies when the browser keeps none.
  let visitor: string | undefined;
  let session: { id: string; lastActivity: number } | undefined;
  // The registrable domain once found (undefined: host-only); null: the browser keeps no cookie.
  let domain: string | undefined | null;
  let resolved = false;

  const hostname = (): string => new URL(host.location.href).hostname;
  const mint = (): string => uuidv7(now(), random(10));

  /** Where the cookies go: the shortest domain the browser keeps a probe cookie on. */
  const resolveDomain = (): string | undefined | null => {
    if (resolved) return domain;
    resolved = true;
    domain = null;
    let token = "";
    for (const byte of random(8)) token += (byte + 256).toString(16).slice(1);
    for (const candidate of candidateDomains(hostname())) {
      doc.cookie = cookieString(PROBE_COOKIE, token, 10, candidate);
      if (readCookie(doc.cookie, PROBE_COOKIE) === token) {
        doc.cookie = cookieString(PROBE_COOKIE, "", 0, candidate);
        domain = candidate;
        return domain;
      }
    }
    warn("amanda: the browser keeps no cookie on this page, so the visitor's ids last for this page alone");
    return domain;
  };

  const store = (): void => {
    const target = resolveDomain();
    if (target === null || visitor === undefined || session === undefined) return;
    doc.cookie = cookieString(VISITOR_COOKIE, `${COOKIE_VERSION}.${visitor}`, VISITOR_MAX_AGE_S, target);
    doc.cookie = cookieString(
      SESSION_COOKIE,
      `${COOKIE_VERSION}.${session.id}.${session.lastActivity}`,
      SESSION_TIMEOUT_MS / 1000,
      target,
    );
  };

  return {
    ids() {
      const at = now();
      const cookies = doc.cookie;
      // The cookies are the record wherever the browser keeps them: one gone has expired, or was
      // deleted by a withdrawal in another tab, and its id never comes back from memory.
      const inMemory = resolved && domain === null;
      visitor = parseVisitor(readCookie(cookies, VISITOR_COOKIE)) ?? (inMemory ? visitor : undefined) ?? mint();
      const last = parseSession(readCookie(cookies, SESSION_COOKIE)) ?? (inMemory ? session : undefined);
      session = { id: last && at - last.lastActivity < SESSION_TIMEOUT_MS ? last.id : mint(), lastActivity: at };
      store();
      return { visitorId: visitor, sessionId: session.id };
    },
    renew() {
      visitor = mint();
      session = { id: mint(), lastActivity: now() };
      store();
    },
    forget() {
      visitor = undefined;
      session = undefined;
      // Only cookies that are there are deleted, so a visitor who never granted has none written.
      const present = [VISITOR_COOKIE, SESSION_COOKIE].filter((name) => readCookie(doc.cookie, name) !== undefined);
      if (present.length === 0) return;
      // On every domain they may be on, host-only included: the tag's own, and any the collector
      // re-issued through a proxy.
      const domains = candidateDomains(hostname());
      if (domains[0] !== undefined) domains.push(undefined);
      for (const name of present) {
        for (const candidate of domains) doc.cookie = cookieString(name, "", 0, candidate);
      }
      const left = present.filter((name) => readCookie(doc.cookie, name) !== undefined);
      // A cookie on another path than / can't be reached from here: said, never ignored.
      if (left.length > 0) warn(`amanda: consent was withdrawn, but ${left.join(" and ")} could not be deleted`);
    },
  };
}
