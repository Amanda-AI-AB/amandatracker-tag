// The tag's endpoint: the base for its config (cfg/), its events (v1/) and its adapter files. The
// script tag's data-endpoint attribute sets it, so that a site behind a first-party reverse proxy
// (docs/first-party-proxy.md) sends everything through its own origin, e.g. data-endpoint="/amnda".

import { ADAPTER_NAME } from "./adapter-name.mjs";

export const DEFAULT_ENDPOINT = "https://eu.serversider.com";

export class EndpointError extends Error {
  override name = "EndpointError";

  // ES2018's Error has no options argument, so the cause is set here rather than passed to super.
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

/** The page the tag runs on: its location.href and location.origin, which are separate because a
 * sandboxed iframe's origin is the opaque "null" whatever its URL. */
export interface PageLocation {
  readonly href: string;
  readonly origin: string;
}

/**
 * Resolves a data-endpoint value as the browser resolves a link on the page: against its URL, so
 * "/amnda" is a path on the page's origin and "amnda" is one beside the page. No value means the
 * default collection host. The result must be https:, or http: on the page's own origin (a
 * development site); any other scheme (blob:, data:, javascript:, file:, ...) is refused by name. The
 * result has no trailing slash: configUrl, eventsUrl and adapterUrl take it as it is, and this is the
 * one place that normalises it.
 */
export function resolveEndpoint(value: string | null | undefined, page: PageLocation): string {
  const raw = value == null ? "" : value.trim();
  if (raw === "") return DEFAULT_ENDPOINT;
  let url: URL;
  try {
    url = new URL(raw, page.href);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    if (!URL_SCHEME.test(raw) && !isBaseUrl(page.href)) {
      throw new EndpointError(
        `a relative data-endpoint cannot resolve against this page's URL, ${page.href}: ${raw}`,
        error,
      );
    }
    throw new EndpointError(`invalid data-endpoint: ${raw}`, error);
  }
  const httpOnOwnOrigin = url.protocol === "http:" && url.origin === page.origin;
  if (url.protocol !== "https:" && !httpOnOwnOrigin) {
    throw new EndpointError(
      `data-endpoint must be https:, or http: on the page's own origin, not ${url.protocol}: ${raw}`,
    );
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new EndpointError(`data-endpoint must not carry credentials, a query or a fragment: ${raw}`);
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Whether a relative URL resolves against `href`: not against a blank or srcdoc page's about: URL. */
function isBaseUrl(href: string): boolean {
  try {
    new URL("x", href);
    return true;
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

/**
 * The script element whose code is running, read through Document.prototype's own getter. A named
 * element (<img name="currentScript">, <form name="currentScript">) shadows document.currentScript
 * on the document itself (DOM clobbering, as in webpack's CVE-2024-43788), but not the prototype's
 * getter. Call it once, synchronously at the top level of a.js: after an await, in a callback or from
 * a module script it is null.
 */
export function currentScript(doc: Document): Element | null {
  const getter = Object.getOwnPropertyDescriptor(Document.prototype, "currentScript")?.get;
  if (!getter) throw new EndpointError("Document.prototype has no currentScript getter");
  return getter.call(doc) as Element | null;
}

/**
 * The endpoint the installing script tag names; `script` is currentScript(document) at boot, and
 * `page` is location. The script must be a <script> element: anything else, or null, throws
 * EndpointError, so that a clobbered or lost currentScript never silently sends a proxied site's
 * traffic to another host. Only a script without data-endpoint gets the default.
 */
export function endpointFromScript(script: Element | null, page: PageLocation): string {
  if (script === null) {
    throw new EndpointError("no current script: read currentScript synchronously at the top level of a.js");
  }
  if (script.tagName !== "SCRIPT") {
    throw new EndpointError(`the current script is a <${script.tagName.toLowerCase()}>, not a <script>`);
  }
  return resolveEndpoint(script.getAttribute("data-endpoint"), page);
}

export function configUrl(endpoint: string, siteId: string): string {
  return `${endpoint}/cfg/${encodeURIComponent(siteId)}.json`;
}

export function eventsUrl(endpoint: string): string {
  return `${endpoint}/v1/e`;
}

/** Where the tag's error boundary posts its reports (schema/v1/tag-error.json). */
export function tagErrorsUrl(endpoint: string): string {
  return `${endpoint}/v1/t`;
}

export { ADAPTER_NAME };

/**
 * A consent-manager adapter's file as the release publishes it: dist/adapters/<name>.js, uploaded
 * beside a.<version>.js as adapters/<version>/<name>.js, so a core asks for the adapters built with
 * it and never another release's. Adapters are code run on the customer's page, so they load only
 * from the collection host or the page's own origin (a first-party proxy, docs/first-party-proxy.md);
 * an endpoint on any other origin throws EndpointError, whatever data-endpoint or the config it
 * served says.
 */
export function adapterUrl(endpoint: string, version: string, name: string, pageOrigin: string): string {
  if (!ADAPTER_NAME.test(name)) {
    throw new Error(`invalid adapter name: ${name}`);
  }
  const origin = new URL(endpoint).origin;
  if (origin !== DEFAULT_ENDPOINT && origin !== pageOrigin) {
    throw new EndpointError(`adapters load only from ${DEFAULT_ENDPOINT} or the page's own origin, not ${origin}`);
  }
  return `${endpoint}/adapters/${encodeURIComponent(version)}/${name}.js`;
}

/**
 * The most UTF-8 bytes of the tag's own keepalive bodies in flight at once. The Fetch spec caps
 * the bodies (not the headers) of all in-flight keepalive requests of a document at 64 KiB
 * together, and fetch rejects one that would go over with a TypeError before sending anything.
 * That quota is shared with every other script on the page: sendBeacon counts against it too,
 * and so do GA4's, Meta's and any other tracker's beacons fired on the same pagehide. The tag
 * can neither see nor reserve their share, so the 4 KiB under 64 KiB is a margin for small
 * third-party beacons, not a guarantee: a pagehide fetch within this limit can still be rejected,
 * and the transport (AAI-68, AAI-893) must catch that TypeError rather than lose the batch.
 */
export const KEEPALIVE_BODY_LIMIT = 60 * 1024;

export class BatchSizeError extends Error {
  override name = "BatchSizeError";
}

/** The size of a request body as sent: its UTF-8 bytes, not its UTF-16 length. */
export function bodyBytes(body: string): number {
  return new TextEncoder().encode(body).length;
}

/**
 * The referrer policy of every request the tag makes to its endpoint: batches, the config fetch and
 * the adapter scripts. The browser's default sends the full page URL, query included, as Referer to
 * a same-origin proxy, which would undo the ping's path-only scrubbing. strict-origin sends the
 * page's origin alone, and, unlike no-referrer, keeps the Origin header of a same-origin POST.
 */
export const REFERRER_POLICY: ReferrerPolicy = "strict-origin";

/** The fetch options for the site's config from configUrl. It sends no cookie, to any host. */
export function configRequestInit(): RequestInit {
  return { credentials: "omit", referrerPolicy: REFERRER_POLICY };
}

/**
 * The fetch options for a tag error to tagErrorsUrl; `body` is a WireTagError as JSON. It is sent
 * whatever the visitor's consent, so, like a ping, it never carries the site's cookies.
 */
export function tagErrorRequestInit(body: string): RequestInit {
  return { method: "POST", body, credentials: "omit", referrerPolicy: REFERRER_POLICY };
}

/**
 * Which WireBatch (schema/v1/batch.json) a request carries: events, sent with consent, or the
 * anonymous pings of declined mode. A batch is never both.
 */
export type BatchKind = "events" | "pings";

/**
 * The fetch options for a batch to eventsUrl; `body` is a WireBatch of `kind` as JSON.
 *
 * An event batch goes with credentials: "same-origin", which lets the browser store the Set-Cookie
 * with which the collector, behind a first-party proxy, re-issues _amnda_id and _amnda_ses
 * (AAI-827); to the cross-origin default host no cookie is sent or stored. A ping batch goes with
 * credentials: "omit": it never carries the site's cookies, even to a same-origin proxy, and the
 * browser ignores any Set-Cookie in its response. The transport (AAI-68) uses these for every
 * fetch it sends, and sends the pageview's immediate flush with fetch, never sendBeacon, so at
 * least one event batch per page gets the server-set cookies whatever a browser does with a
 * beacon's response.
 *
 * keepalive, which lets a batch outlive the page, is set only for the pagehide flush (`unload`).
 * An ordinary batch goes without it, so that it never counts against the browser's 64 KiB
 * keepalive quota and a large one is never refused for it. A pagehide body over
 * KEEPALIVE_BODY_LIMIT throws BatchSizeError: the transport splits the unload flush by
 * bodyBytes, and keeps the bodies it has in flight within KEEPALIVE_BODY_LIMIT together.
 */
export function batchRequestInit(body: string, kind: BatchKind, unload = false): RequestInit {
  const init: RequestInit = {
    method: "POST",
    body,
    credentials: kind === "events" ? "same-origin" : "omit",
    referrerPolicy: REFERRER_POLICY,
  };
  if (!unload) return init;
  const bytes = bodyBytes(body);
  if (bytes > KEEPALIVE_BODY_LIMIT) {
    throw new BatchSizeError(`keepalive body is ${bytes} bytes, over ${KEEPALIVE_BODY_LIMIT}`);
  }
  init.keepalive = true;
  return init;
}
