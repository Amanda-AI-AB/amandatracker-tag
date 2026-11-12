// Consent-manager adapters ship as separate IIFE files (dist/adapters/<name>.js) so that the core
// bundle stays within its size budget; the core injects one only when a site's config names it.

const ADAPTER_NAME = /^[a-z0-9-]+$/;

export function adapterUrl(baseUrl: string, name: string): string {
  if (!ADAPTER_NAME.test(name)) {
    throw new Error(`invalid adapter name: ${name}`);
  }
  return `${baseUrl.replace(/\/+$/, "")}/adapters/${name}.js`;
}

export function loadAdapter(doc: Document, baseUrl: string, name: string): Promise<void> {
  const src = adapterUrl(baseUrl, name);
  return new Promise((resolve, reject) => {
    const script = doc.createElement("script");
    script.async = true;
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`failed to load adapter ${name} from ${src}`));
    (doc.head || doc.documentElement).appendChild(script);
  });
}
