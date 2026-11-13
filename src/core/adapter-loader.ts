// Consent-manager adapters ship as separate IIFE files (dist/adapters/<name>.js) so that the core
// bundle stays within its size budget; the core injects one only when a site's config names it.

import { ADAPTER_INTEGRITY, TAG_VERSION } from "./build-info";
import { REFERRER_POLICY, adapterUrl } from "./endpoint";

/**
 * Injects an adapter's script, of this core's own version and pinned by the SRI hash the build
 * baked in; `endpoint` is one resolveEndpoint returned for `pageOrigin`. It rejects, before injecting
 * anything, for an invalid adapter name, an adapter this core wasn't built with and an endpoint off
 * the collection host and the page's origin: every failure is a rejection, never a synchronous throw,
 * so a caller's .catch sees them all. The script is fetched in CORS mode without credentials, which
 * SRI needs for a cross-origin file, and sends the page's origin alone as Referer (REFERRER_POLICY).
 */
export async function loadAdapter(doc: Document, endpoint: string, name: string, pageOrigin: string): Promise<void> {
  const src = adapterUrl(endpoint, TAG_VERSION, name, pageOrigin);
  if (!Object.prototype.hasOwnProperty.call(ADAPTER_INTEGRITY, name)) {
    throw new Error(`no adapter ${name} in tag ${TAG_VERSION}`);
  }
  const integrity = ADAPTER_INTEGRITY[name]!;
  return new Promise((resolve, reject) => {
    const script = doc.createElement("script");
    script.async = true;
    script.crossOrigin = "anonymous";
    script.integrity = integrity;
    script.referrerPolicy = REFERRER_POLICY;
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`failed to load adapter ${name} from ${src}`));
    (doc.head || doc.documentElement).appendChild(script);
  });
}
