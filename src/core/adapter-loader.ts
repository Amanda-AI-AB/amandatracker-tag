// Consent-manager adapters ship as separate IIFE files (dist/adapters/<name>.js) so that the core
// bundle stays within its size budget; the core injects one only when a site's config names it.

import { adapterUrl } from "./endpoint";

/** Injects an adapter's script; `endpoint` is one resolveEndpoint returned. */
export function loadAdapter(doc: Document, endpoint: string, name: string): Promise<void> {
  const src = adapterUrl(endpoint, name);
  return new Promise((resolve, reject) => {
    const script = doc.createElement("script");
    script.async = true;
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`failed to load adapter ${name} from ${src}`));
    (doc.head || doc.documentElement).appendChild(script);
  });
}
