// The site's public config, cfg/<SITE_PUBLIC_ID>.json: rendered by the control plane's publisher
// (amandatracker, AAI-91), served from the CDN and fetched anonymously once per page at boot. Its
// layout is the publisher's `schema_version: 1`: site, config_version, endpoint, domains, consent,
// features, custom_params, paused, the kill switch (AAI-92; a paused tag sends nothing, AAI-797), telemetry, whose
// error_sample_rate overrides the tag's ERROR_SAMPLE_RATE, and bundle_version, the canary pin
// (AAI-149, canary.ts), and features, whose identify_enabled turns amanda('identify') on (AAI-786,
// identify.ts), outbound_clicks_enabled turns outbound link clicks off (AAI-167, outbound.ts) and
// ga4_ecommerce_enabled turns the GA4 e-commerce auto-map on (AAI-974, ecommerce.ts), and domains,
// the site's own, whose links aren't outbound, and linker, the cross-domain linker's verified
// same-owner domains (AAI-218, linker.ts). The tag checks what it reads here; the tickets that use a section (consent AAI-84, ...) check that
// section's fields. Sections it doesn't read pass through unchecked, such as geo ({ city: true }),
// which only the collector reads (AAI-199, AAI-1144).

import { CUSTOM_PARAMS_MAP, TRACKED_EVENT_MAX_LENGTH, TRACKED_EVENT_PATTERN } from "../wire/generated";
import type { DeclinedMode, NoCmpPolicy } from "./consent";
import { configRequestInit, configUrl } from "./endpoint";
import { isRecord } from "./guards";

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
  if (!SITE_ID.test(site)) {
    throw new ConfigError(`data-site (or a.js?site=) is missing or not a site id: ${JSON.stringify(value)}`);
  }
  return site;
}

/**
 * A fetched config, checked: an object of this tag's layout, for the site that asked for it, with
 * a config_version. Throws ConfigError otherwise, since running on another layout or another
 * site's settings could collect what the site turned off.
 */
export function parseConfig(json: unknown, site: string): SiteConfig {
  if (!isRecord(json)) throw new ConfigError("the config is not a JSON object");
  const config = json;
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
  checkPaused(config.paused);
  checkTelemetry(config.telemetry);
  checkConsent(config.consent);
  checkCustomParams(config.custom_params);
  checkBundleVersion(config.bundle_version);
  checkFeatures(config.features);
  checkDomains(config.domains, "domains");
  checkLinker(config.linker);
  return config as SiteConfig;
}

/**
 * The config's optional linker section (AAI-789, AAI-218): { domains }, the site's verified
 * same-owner domains the cross-domain linker (linker.ts) carries the visitor's ids between, a list
 * of hostnames as domains is; the publisher lists none while the linker is off. A section of another
 * shape throws ConfigError, since guessing the set could carry the visitor's ids to a domain the
 * owner never verified.
 */
function checkLinker(linker: unknown): void {
  if (linker === undefined) return;
  if (!isRecord(linker)) throw new ConfigError("the config's linker is not an object");
  checkDomains(linker.domains, "linker.domains");
}

/**
 * The domains the cross-domain linker carries the visitor's ids between: the config's
 * linker.domains, read as ownDomains reads domains. None, the linker off, when it sets none.
 */
export function linkerDomains(config: SiteConfig): string[] {
  const linker = config.linker as { domains?: string[] } | undefined;
  return ((linker && linker.domains) || []).map((domain) => hostnameOf(domain)!);
}

/** A hostname, as the wire schema's LinkHost has it: what a browser's URL parser makes of one. */
const HOSTNAME_PATTERN = new RegExp(TRACKED_EVENT_PATTERN.link_host);

/** What a domain in the config may not hold, before its hostname is read: a scheme, port, path, credentials or space. */
const NOT_A_HOSTNAME = /[\s/\\?#@:[\]]/;

/**
 * The config's optional domains (AAI-91, the site's own domains): a list of hostnames, each of which
 * owns its subdomains too (outbound.ts). Anything but a list of hostnames throws ConfigError, since
 * guessing which hosts are the site's own could send the hosts of its internal links as outbound,
 * or miss its outbound ones.
 */
function checkDomains(domains: unknown, name: string): void {
  if (domains === undefined) return;
  if (!Array.isArray(domains)) throw new ConfigError(`the config's ${name} is not a list`);
  for (const domain of domains) {
    const host = typeof domain === "string" && !NOT_A_HOSTNAME.test(domain) ? hostnameOf(domain) : undefined;
    if (host === undefined) throw new ConfigError(`the config's ${name} holds a value that is not a hostname: ${String(domain)}`);
  }
}

/** domain's hostname as a URL parser reads it, without a trailing dot; undefined when it reads none, or one LinkHost refuses. */
function hostnameOf(domain: string): string | undefined {
  let url: URL;
  try {
    url = new URL(`https://${domain}/`);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return undefined;
  }
  const host = trimDot(url.hostname);
  return HOSTNAME_PATTERN.test(host) && host.length <= TRACKED_EVENT_MAX_LENGTH.link_host ? host : undefined;
}

/** hostname without the trailing dot of a fully qualified name, which names the same host. */
export function trimDot(hostname: string): string {
  return hostname.charAt(hostname.length - 1) === "." ? hostname.slice(0, -1) : hostname;
}

/**
 * The site's own domains, the config's domains, as a browser's URL parser reads a link's hostname,
 * so that the two compare: lower case, an internationalised name in punycode, without a trailing
 * dot. None when the config sets none.
 */
export function ownDomains(config: SiteConfig): string[] {
  // checkDomains has accepted each, so each has a hostname.
  return ((config.domains as string[] | undefined) || []).map((domain) => hostnameOf(domain)!);
}

/**
 * The config's optional paused, the site's kill switch (AAI-92): a boolean. Anything else throws
 * ConfigError, so the tag doesn't run, since guessing whether a site paused tracking could collect
 * from a site that stopped it.
 */
function checkPaused(paused: unknown): void {
  if (paused !== undefined && typeof paused !== "boolean") {
    throw new ConfigError(`the config's paused is not a boolean: ${String(paused)}`);
  }
}

/**
 * Whether the site paused tracking: the config's paused, the kill switch (AAI-92, AAI-797), off when
 * it sets none. A paused tag sends nothing (boot.ts).
 */
export function paused(config: SiteConfig): boolean {
  return config.paused === true;
}

/**
 * The config's optional features section, the site's feature toggles; this tag reads its
 * identify_enabled (AAI-786), outbound_clicks_enabled (AAI-167) and ga4_ecommerce_enabled (AAI-974), booleans. A section of another shape, or a toggle of another type,
 * throws ConfigError, since guessing a toggle could send what the site never turned on. Its other
 * toggles are the tickets' that use them.
 */
function checkFeatures(features: unknown): void {
  if (features === undefined) return;
  if (!isRecord(features)) throw new ConfigError("the config's features is not an object");
  for (const toggle of ["identify_enabled", "outbound_clicks_enabled", "ga4_ecommerce_enabled"]) {
    const value = features[toggle];
    if (value !== undefined && typeof value !== "boolean") {
      throw new ConfigError(`the config's features.${toggle} is not a boolean: ${String(value)}`);
    }
  }
}

/**
 * Whether the site captures outbound link clicks (outbound.ts): the config's
 * features.outbound_clicks_enabled, on when it sets none (AAI-167, AAI-172).
 */
export function outboundClicksEnabled(config: SiteConfig): boolean {
  const features = config.features as { outbound_clicks_enabled?: boolean } | undefined;
  return !(features && features.outbound_clicks_enabled === false);
}

/**
 * Whether the site turned identify() on: the config's features.identify_enabled, off when it sets
 * none (AAI-786; the setting is legal-badged and gated on the DPA addendum, AAI-197, AAI-198).
 */
export function identifyEnabled(config: SiteConfig): boolean {
  const features = config.features as { identify_enabled?: boolean } | undefined;
  return !!features && features.identify_enabled === true;
}

/**
 * Whether the site turned the GA4 e-commerce auto-map on (ecommerce.ts): the config's
 * features.ga4_ecommerce_enabled, off when it sets none (AAI-974).
 */
export function ga4EcommerceEnabled(config: SiteConfig): boolean {
  const features = config.features as { ga4_ecommerce_enabled?: boolean } | undefined;
  return !!features && features.ga4_ecommerce_enabled === true;
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
 * gpc_honored, has_cmp, pings_include_click_ids and purge_on_withdrawal, booleans, and its
 * no_cmp_policy (NO_CMP_POLICIES). A section of another shape, or another value, throws
 * ConfigError: guessing a mode could send pings from a site that chose to send nothing, guessing
 * the GPC toggle could ignore a visitor's opt-out, guessing a no-CMP policy could grant what the
 * site chose to deny, guessing the click-ID toggle could make a ping click-linkable on a site that
 * never accepted it, and guessing the purge toggle could erase, or keep, what the site chose
 * otherwise. Its other fields are the tickets' that use them.
 */
function checkConsent(consent: unknown): void {
  if (consent === undefined) return;
  if (!isRecord(consent)) throw new ConfigError("the config's consent is not an object");
  const section = consent;
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
  const cmp = section.has_cmp;
  if (cmp !== undefined && typeof cmp !== "boolean") {
    throw new ConfigError(`the config's consent.has_cmp is not a boolean: ${String(cmp)}`);
  }
  const clickIds = section.pings_include_click_ids;
  if (clickIds !== undefined && typeof clickIds !== "boolean") {
    throw new ConfigError(`the config's consent.pings_include_click_ids is not a boolean: ${String(clickIds)}`);
  }
  const purge = section.purge_on_withdrawal;
  if (purge !== undefined && typeof purge !== "boolean") {
    throw new ConfigError(`the config's consent.purge_on_withdrawal is not a boolean: ${String(purge)}`);
  }
}

/**
 * Whether a withdrawal erases the visitor's stored data: the config's consent.purge_on_withdrawal,
 * off when it sets none (AAI-226, AAI-785). With it on, the tag sends the withdrawal signal with the
 * visitor id before it deletes the cookies (feed.ts); with it off, a withdrawal only deletes them.
 */
export function purgeOnWithdrawal(config: SiteConfig): boolean {
  const consent = config.consent as { purge_on_withdrawal?: boolean } | undefined;
  return !!consent && consent.purge_on_withdrawal === true;
}

/**
 * Whether the site's anonymous pings carry the landing URL's click IDs: the config's
 * consent.pings_include_click_ids, off when it sets none (AAI-801, AAI-88). A click ID makes a ping
 * click-linkable, so only a site whose owner accepted that turns it on (a legal-badged setting).
 */
export function pingsIncludeClickIds(config: SiteConfig): boolean {
  const consent = config.consent as { pings_include_click_ids?: boolean } | undefined;
  return !!consent && consent.pings_include_click_ids === true;
}

/**
 * Whether the site has a consent manager: the config's consent.has_cmp, on when it sets none. Only
 * a site that says it has none (has_cmp: false) starts in no_cmp, for its no-CMP policy to decide;
 * guessing that a site has none could let the policy grant before its banner answers.
 */
export function hasCmp(config: SiteConfig): boolean {
  const consent = config.consent as { has_cmp?: boolean } | undefined;
  return !(consent && consent.has_cmp === false);
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
  if (!isRecord(telemetry)) throw new ConfigError("the config's telemetry is not an object");
  const rate = telemetry.error_sample_rate;
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
