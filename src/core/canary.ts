// The canary pin (AAI-149): staged rollout without a loader split. The site's config may carry a
// bundle_version (config.ts); when it names a build other than the running one, the tag doesn't
// start, but hands off to that versioned asset, a.<version>.js, which boots in its place. That is one
// extra request, on pinned sites only: a config without a pin, or one that names the running build,
// never makes it. Each build reports its events and tag errors under its own tag_version, so the
// canary's telemetry separates from everyone else's.
//
// The pinned build boots as a.js does: from its script tag's data-site and data-endpoint, which the
// handoff copies, and with the snippet's window.amanda stub, which the handing-off copy never
// replaced. The handoff marks its script tag with HANDOFF_ATTRIBUTE, and a copy booted from a marked
// tag never hands off again, so a page loads at most one pinned build, whatever its config says.

import { REFERRER_POLICY, bundleUrl } from "./endpoint";

/** Set on the script tag of a handed-off build, to the version that handed off. */
export const HANDOFF_ATTRIBUTE = "data-amanda-handoff-from";

/** The installing script tag's attributes that the pinned build boots from. */
const BOOT_ATTRIBUTES = ["data-site", "data-endpoint"] as const;

/** Whether the build booting from `script` was loaded by a handoff, and so must not hand off again. */
export function handedOff(script: Element): boolean {
  return script.getAttribute(HANDOFF_ATTRIBUTE) !== null;
}

/**
 * Whether a build of tagVersion, booted from `script`, hands off to the config's pin: only when the
 * pin names another build, and the build wasn't itself loaded by a handoff.
 */
export function shouldHandOff(pin: string | undefined, tagVersion: string, script: Element): boolean {
  return pin !== undefined && pin !== tagVersion && !handedOff(script);
}

/**
 * Injects the pinned build a.<pin>.js from endpoint, booting from the installing script tag's
 * data-site and data-endpoint, and marked as handed off from `from`. Settles when the script has
 * loaded (the pinned build then runs, and reports its own failures), or rejects when it failed to
 * load; every failure is a rejection, never a synchronous throw, as loadAdapter's.
 */
export async function handOff(
  doc: Document,
  script: Element,
  endpoint: string,
  pin: string,
  from: string,
  pageOrigin: string,
): Promise<void> {
  const src = bundleUrl(endpoint, pin, pageOrigin);
  return new Promise((resolve, reject) => {
    const pinned = doc.createElement("script");
    for (const name of BOOT_ATTRIBUTES) {
      const value = script.getAttribute(name);
      if (value !== null) pinned.setAttribute(name, value);
    }
    pinned.setAttribute(HANDOFF_ATTRIBUTE, from);
    pinned.async = true;
    pinned.referrerPolicy = REFERRER_POLICY;
    pinned.src = src;
    pinned.onload = () => resolve();
    pinned.onerror = () => reject(new Error(`failed to load the pinned build ${pin} from ${src}`));
    (doc.head || doc.documentElement).appendChild(pinned);
  });
}
