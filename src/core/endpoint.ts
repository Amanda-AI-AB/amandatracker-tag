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
 * page's own origin (an http: development site). The result has no trailing slash.
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

/**
 * The fetch options for a batch to eventsUrl. credentials: "same-origin" lets the browser store
 * the Set-Cookie with which the collector, behind a first-party proxy, re-issues _amnda_id and
 * _amnda_ses (AAI-827); to the cross-origin default host no cookie is sent or stored. keepalive
 * lets a batch outlive the page. The transport (AAI-68) uses these for every fetch it sends, and
 * sends the pageview's immediate flush with fetch, never sendBeacon, so at least one batch per
 * page gets the server-set cookies whatever a browser does with a beacon's response.
 */
export function batchRequestInit(body: string): RequestInit {
  return { method: "POST", body, credentials: "same-origin", keepalive: true };
}
