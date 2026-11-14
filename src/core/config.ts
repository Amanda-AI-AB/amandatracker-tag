// The site's public config, cfg/<SITE_PUBLIC_ID>.json: rendered by the control plane's publisher
// (amandatracker, AAI-91), served from the CDN and fetched anonymously once per page at boot. Its
// layout is the publisher's `schema_version: 1`: site, config_version, endpoint, domains, consent,
// features, custom_params, paused, the kill switch (AAI-92), telemetry, whose
// error_sample_rate overrides the tag's ERROR_SAMPLE_RATE, and bundle_version, the canary pin
// (AAI-149, canary.ts), and features, whose identify_enabled turns amanda('identify') on (AAI-786,
// identify.ts). The tag checks what it reads
// here; the tickets that use a section (consent AAI-84, kill switch AAI-797, ...) check that
// section's fields.

import { CUSTOM_PARAMS_MAP, TRACKED_EVENT_MAX_LENGTH, TRACKED_EVENT_PATTERN } from "../wire/generated";
import type { DeclinedMode, NoCmpPolicy } from "./consent";
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
  checkCustomParams(config.custom_params);
  checkBundleVersion(config.bundle_version);
  checkFeatures(config.features);
  return config as SiteConfig;
}

/**
 * The config's optional features section, the site's feature toggles; this tag reads its
 * identify_enabled, a boolean (AAI-786). A section of another shape, or a toggle of another type,
 * throws ConfigError, since guessing a toggle could send what the site never turned on. Its other
 * toggles are the tickets' that use them.
 */
function checkFeatures(features: unknown): void {
  if (features === undefined) return;
  if (typeof features !== "object" || features === null || Array.isArray(features)) {
    throw new ConfigError("the config's features is not an object");
  }
  const identify = (features as Record<string, unknown>).identify_enabled;
  if (identify !== undefined && typeof identify !== "boolean") {
    throw new ConfigError(`the config's features.identify_enabled is not a boolean: ${String(identify)}`);
  }
}

/**
 * Whether the site turned identify() on: the config's features.identify_enabled, off when it sets
 * none (AAI-786; the setting is legal-badged and gated on the DPA addendum, AAI-197, AAI-198).
 */
export function identifyEnabled(config: SiteConfig): boolean {
  const features = config.features as { identify_enabled?: boolean } | undefined;
  return !!features && features.identify_enabled === true;
}

/** A tag version, as the wire schema's TagVersion has it: semver, at most 64 characters. */
const TAG_VERSION_PATTERN = new RegExp(TRACKED_EVENT_PATTERN.tag_version);

/**
 * The config's optional bundle_version (AAI-149, published by AAI-799): the canary pin, the tag
 * version the site is to run instead of the evergreen a.js's. Anything but a tag version throws
 * ConfigError, since running a build the publisher never named could be any build.
 */
function checkBundleVersion(version: unknown): void {
  if (version === undefined) return;
  if (typeof version !== "string" || version.length > TRACKED_EVENT_MAX_LENGTH.tag_version || !TAG_VERSION_PATTERN.test(version)) {
    throw new ConfigError(`the config's bundle_version is not a tag version: ${String(version)}`);
  }
}

/** The tag version the config pins the site to, or undefined when it pins none. */
export function bundleVersion(config: SiteConfig): string | undefined {
  return config.bundle_version as string | undefined;
}

/** The most custom attribution parameters a site may name: the wire's CustomParams cap. */
export const MAX_CUSTOM_PARAMS = CUSTOM_PARAMS_MAP.maxProperties;

/**
 * The config's optional custom_params (site_settings.custom_params, AAI-90): the names of the
 * site's own attribution parameters, which the tag reads from the landing URL beside the UTMs and
 * click IDs (attribution.ts). A list of non-empty strings, at most MAX_CUSTOM_PARAMS of them;
 * anything else throws ConfigError, since guessing which parameters the site meant would send what
 * it never asked for, or lose what it did.
 */
function checkCustomParams(params: unknown): void {
  if (params === undefined) return;
  if (!Array.isArray(params)) throw new ConfigError("the config's custom_params is not a list");
  if (params.length > MAX_CUSTOM_PARAMS) {
    throw new ConfigError(`the config's custom_params names more than ${MAX_CUSTOM_PARAMS} parameters`);
  }
  for (const name of params) {
    if (typeof name !== "string" || name === "") {
      throw new ConfigError(`the config's custom_params holds a name that is not a non-empty string: ${String(name)}`);
    }
  }
}

/** The site's custom attribution parameters: the config's custom_params, none when it sets none. */
export function customParams(config: SiteConfig): readonly string[] {
  return (config.custom_params as readonly string[] | undefined) || [];
}

/** The declined modes a site can choose (02 §2); `off` is the default for a site that sets none. */
const DECLINED_MODES: readonly DeclinedMode[] = ["off", "pings"];

/**
 * The no-CMP policies a site can choose (02 §4), named as site_settings.no_cmp_policy (AAI-90):
 * `geo`, the default, asks GET /v1/policy; `assume_denied` always denies; `assume_granted` always
 * grants, a badged setting the control plane lets through only with its legal acceptance.
 */
const NO_CMP_POLICIES: readonly NoCmpPolicy[] = ["geo", "assume_denied", "assume_granted"];

/**
 * The config's optional consent section; this tag reads its declined_mode, `off` or `pings`, its
 * gpc_honored, a boolean, and its no_cmp_policy (NO_CMP_POLICIES). A section of another shape, or
 * another value, throws ConfigError: guessing a mode could send pings from a site that chose to
 * send nothing, guessing the GPC toggle could ignore a visitor's opt-out, and guessing a no-CMP
 * policy could grant what the site chose to deny. Its other fields are the tickets' that use them.
 */
function checkConsent(consent: unknown): void {
  if (consent === undefined) return;
  if (typeof consent !== "object" || consent === null || Array.isArray(consent)) {
    throw new ConfigError("the config's consent is not an object");
  }
  const section = consent as Record<string, unknown>;
  const mode = section.declined_mode;
  if (mode !== undefined && DECLINED_MODES.indexOf(mode as DeclinedMode) < 0) {
    throw new ConfigError(`the config's consent.declined_mode is not one of ${DECLINED_MODES.join(", ")}: ${String(mode)}`);
  }
  const gpc = section.gpc_honored;
  if (gpc !== undefined && typeof gpc !== "boolean") {
    throw new ConfigError(`the config's consent.gpc_honored is not a boolean: ${String(gpc)}`);
  }
  const policy = section.no_cmp_policy;
  if (policy !== undefined && NO_CMP_POLICIES.indexOf(policy as NoCmpPolicy) < 0) {
    throw new ConfigError(`the config's consent.no_cmp_policy is not one of ${NO_CMP_POLICIES.join(", ")}: ${String(policy)}`);
  }
}

/** The site's no-CMP policy: the config's consent.no_cmp_policy, or `geo` when it sets none. */
export function noCmpPolicy(config: SiteConfig): NoCmpPolicy {
  const consent = config.consent as { no_cmp_policy?: NoCmpPolicy } | undefined;
  return (consent && consent.no_cmp_policy) || "geo";
}

/** The site's declined mode: the config's consent.declined_mode, or `off` when it sets none. */
export function declinedMode(config: SiteConfig): DeclinedMode {
  const consent = config.consent as { declined_mode?: DeclinedMode } | undefined;
  return (consent && consent.declined_mode) || "off";
}

/**
 * Whether the site honors Global Privacy Control as a decline: the config's
 * consent.gpc_honored, on when it sets none (01 §3).
 */
export function gpcHonored(config: SiteConfig): boolean {
  const consent = config.consent as { gpc_honored?: boolean } | undefined;
  return !(consent && consent.gpc_honored === false);
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
