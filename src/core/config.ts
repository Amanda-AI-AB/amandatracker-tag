// The site's public config, cfg/<SITE_PUBLIC_ID>.json: rendered by the control plane's publisher
// (amandatracker, AAI-91), served from the CDN and fetched anonymously once per page at boot. Its
// layout is the publisher's `schema_version: 1`: site, config_version, endpoint, domains, consent,
// features, custom_params, and paused, the kill switch (AAI-92). The tag checks what it reads
// here; the tickets that use a section (consent AAI-84, kill switch AAI-797, ...) check that
// section's fields.

import { configRequestInit, configUrl } from "./endpoint";

/** The config layout this tag reads. */
export const CONFIG_SCHEMA_VERSION = 1;

/** The site's public id, as the schema's SiteId has it. */
const SITE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface SiteConfig {
  readonly schema_version: typeof CONFIG_SCHEMA_VERSION;
  readonly site: string;
  readonly config_version: number;
  readonly [section: string]: unknown;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** The site id the snippet names, checked; throws ConfigError for a missing or malformed one. */
export function checkSiteId(value: string | null | undefined): string {
  const site = value == null ? "" : value.trim();
  if (!SITE_ID.test(site)) throw new ConfigError(`data-site is missing or not a site id: ${JSON.stringify(value)}`);
  return site;
}

/**
 * A fetched config, checked: an object of this tag's layout, for the site that asked for it, with
 * a config_version. Throws ConfigError otherwise, since running on another layout or another
 * site's settings could collect what the site turned off.
 */
export function parseConfig(json: unknown, site: string): SiteConfig {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new ConfigError("the config is not a JSON object");
  }
  const config = json as Record<string, unknown>;
  if (config.schema_version !== CONFIG_SCHEMA_VERSION) {
    throw new ConfigError(`the config's schema_version is ${String(config.schema_version)}, not ${CONFIG_SCHEMA_VERSION}`);
  }
  if (config.site !== site) {
    throw new ConfigError(`the config is for site ${String(config.site)}, not ${site}`);
  }
  const version = config.config_version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    throw new ConfigError(`the config's config_version is not a version: ${String(version)}`);
  }
  return config as SiteConfig;
}

/**
 * Fetches and checks the site's config from endpoint, without cookies (configRequestInit). A
 * response other than 2xx, or a body that isn't JSON, rejects with ConfigError; a network
 * failure rejects with fetch's own TypeError.
 */
export async function fetchConfig(fetchFn: typeof fetch, endpoint: string, site: string): Promise<SiteConfig> {
  const url = configUrl(endpoint, site);
  const response = await fetchFn(url, configRequestInit());
  if (!response.ok) throw new ConfigError(`GET ${url}: HTTP ${response.status}`);
  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ConfigError(`GET ${url}: the body is not JSON`);
  }
  return parseConfig(json, site);
}
