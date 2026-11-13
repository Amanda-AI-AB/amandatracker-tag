// The tag's endpoint: the base for its config (cfg/), its events (v1/) and its adapter files. The
// script tag's data-endpoint attribute sets it, so that a site behind a first-party reverse proxy
// (docs/first-party-proxy.md) sends everything through its own origin, e.g. data-endpoint="/amnda".

export const DEFAULT_ENDPOINT = "https://eu.serversider.com";

export class EndpointError extends Error {
  override name = "EndpointError";
}

/**
 * Resolves a data-endpoint value against the page's origin. No value means the default collection
 * host. A relative value is a path on the page's own origin. Anything else must be https:, or the
 * page's own origin (an http: development site). The result has no trailing slash: configUrl,
 * eventsUrl and adapterUrl take it as it is, and this is the one place that normalises it.
 */
export function resolveEndpoint(value: string | null | undefined, pageOrigin: string): string {
  const raw = value == null ? "" : value.trim();
  if (raw === "") return DEFAULT_ENDPOINT;
  let url: URL;
  try {
    url = new URL(raw, pageOrigin);
  } catch (error) {
    if (error instanceof TypeError) throw new EndpointError(`invalid data-endpoint: ${raw}`);
    throw error;
  }
  if (url.protocol !== "https:" && url.origin !== pageOrigin) {
    throw new EndpointError(`data-endpoint must be https: or the page's own origin: ${raw}`);
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new EndpointError(`data-endpoint must not carry credentials, a query or a fragment: ${raw}`);
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** The endpoint the installing script tag names; `script` is document.currentScript at boot. */
export function endpointFromScript(script: Element | null, pageOrigin: string): string {
  return resolveEndpoint(script ? script.getAttribute("data-endpoint") : null, pageOrigin);
}

export function configUrl(endpoint: string, siteId: string): string {
  return `${endpoint}/cfg/${encodeURIComponent(siteId)}.json`;
}

export function eventsUrl(endpoint: string): string {
  return `${endpoint}/v1/e`;
}

const ADAPTER_NAME = /^[a-z0-9-]+$/;

/** A consent-manager adapter's own file (dist/adapters/<name>.js) beside the core. */
export function adapterUrl(endpoint: string, name: string): string {
  if (!ADAPTER_NAME.test(name)) {
    throw new Error(`invalid adapter name: ${name}`);
  }
  return `${endpoint}/adapters/${name}.js`;
}

/**
 * The most UTF-8 bytes of keepalive bodies in flight at once. Browsers cap the bodies of all
 * in-flight keepalive requests of a page at 64 KiB together, and fetch rejects one over it with a
 * TypeError before sending anything; 60 KiB leaves room for the requests' other bytes.
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
 * The fetch options for a batch to eventsUrl. credentials: "same-origin" lets the browser store
 * the Set-Cookie with which the collector, behind a first-party proxy, re-issues _amnda_id and
 * _amnda_ses (AAI-827); to the cross-origin default host no cookie is sent or stored. The
 * transport (AAI-68) uses these for every fetch it sends, and sends the pageview's immediate flush
 * with fetch, never sendBeacon, so at least one batch per page gets the server-set cookies
 * whatever a browser does with a beacon's response.
 *
 * keepalive, which lets a batch outlive the page, is set only for the pagehide flush (`unload`).
 * An ordinary batch goes without it, so that it never counts against the browser's 64 KiB
 * keepalive quota and a large one is never refused for it. A pagehide body over
 * KEEPALIVE_BODY_LIMIT throws BatchSizeError: the transport splits the unload flush by
 * bodyBytes, and keeps the bodies it has in flight within KEEPALIVE_BODY_LIMIT together.
 */
export function batchRequestInit(body: string, unload = false): RequestInit {
  const init: RequestInit = { method: "POST", body, credentials: "same-origin" };
  if (!unload) return init;
  const bytes = bodyBytes(body);
  if (bytes > KEEPALIVE_BODY_LIMIT) {
    throw new BatchSizeError(`keepalive body is ${bytes} bytes, over ${KEEPALIVE_BODY_LIMIT}`);
  }
  init.keepalive = true;
  return init;
}
