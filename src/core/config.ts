// The site's public config, cfg/<SITE_PUBLIC_ID>.json: rendered by the control plane's publisher
// (amandatracker, AAI-91), served from the CDN and fetched anonymously once per page at boot. Its
// layout is the publisher's `schema_version: 1`: site, config_version, endpoint, domains, consent,
// features, custom_params, paused, the kill switch (AAI-92), and telemetry, whose
// error_sample_rate overrides the tag's ERROR_SAMPLE_RATE. The tag checks what it reads
// here; the tickets that use a section (consent AAI-84, kill switch AAI-797, ...) check that
// section's fields.

import type { DeclinedMode } from "./consent";
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
  checkTelemetry(config.telemetry);
  checkConsent(config.consent);
  return config as SiteConfig;
}

/** The declined modes a site can choose (02 §2); `off` is the default for a site that sets none. */
const DECLINED_MODES: readonly DeclinedMode[] = ["off", "pings"];

/**
 * The config's optional consent section; this tag reads its declined_mode, `off` or `pings`. A
 * section of another shape, or another mode, throws ConfigError: guessing a mode could send pings
 * from a site that chose to send nothing. Its other fields are the tickets' that use them.
 */
function checkConsent(consent: unknown): void {
  if (consent === undefined) return;
  if (typeof consent !== "object" || consent === null || Array.isArray(consent)) {
    throw new ConfigError("the config's consent is not an object");
  }
  const mode = (consent as Record<string, unknown>).declined_mode;
  if (mode !== undefined && DECLINED_MODES.indexOf(mode as DeclinedMode) < 0) {
    throw new ConfigError(`the config's consent.declined_mode is not one of ${DECLINED_MODES.join(", ")}: ${String(mode)}`);
  }
}

/** The site's declined mode: the config's consent.declined_mode, or `off` when it sets none. */
export function declinedMode(config: SiteConfig): DeclinedMode {
  const consent = config.consent as { declined_mode?: DeclinedMode } | undefined;
  return (consent && consent.declined_mode) || "off";
}

/**
 * The config's optional telemetry section: { error_sample_rate }, the share of page loads, from 0
 * to 1, that report the tag's failures. A section of any other shape throws ConfigError.
 */
function checkTelemetry(telemetry: unknown): void {
  if (telemetry === undefined) return;
  if (typeof telemetry !== "object" || telemetry === null || Array.isArray(telemetry)) {
    throw new ConfigError("the config's telemetry is not an object");
  }
  const rate = (telemetry as Record<string, unknown>).error_sample_rate;
  if (rate !== undefined && (typeof rate !== "number" || !(rate >= 0 && rate <= 1))) {
    throw new ConfigError(`the config's telemetry.error_sample_rate is not between 0 and 1: ${String(rate)}`);
  }
}

/** The error sample rate the config sets, or undefined when it sets none. */
export function errorSampleRate(config: SiteConfig): number | undefined {
  const telemetry = config.telemetry as { error_sample_rate?: number } | undefined;
  return telemetry === undefined ? undefined : telemetry.error_sample_rate;
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
