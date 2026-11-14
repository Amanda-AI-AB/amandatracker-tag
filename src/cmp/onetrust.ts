// OneTrust, for sites whose OneTrust is set up without Consent Mode or TCF (02 §3.4): the onetrust
// adapter (src/adapters/onetrust.ts) reads window.OnetrustActiveGroups once it connects, and again
// each time OneTrust calls window.OptanonWrapper, which it does once loaded and on every consent
// change: accept, reject and change. The adapter hooks OptanonWrapper, still calling the site's
// own, and also listens for OneTrustGroupsUpdated, so a site that defines its OptanonWrapper after
// the hook is still followed. A read that repeats the last one changes nothing.
//
// OnetrustActiveGroups lists the ids of the groups (categories) the visitor allows, comma
// separated (",C0001,C0002,"). analytics is OneTrust's default Performance group, C0002, and ads its
// Targeting group, C0004: a group the answer leaves out is denied. A visitor who hasn't answered
// the banner yet (OneTrust.IsAlertBoxClosed() is not true) has decided nothing, whatever groups
// OneTrust holds active meanwhile (an opt-out region's defaults hold them all): the signal is none,
// and the state stays unknown, never assumed granted or denied (08 R11).

import type { AdapterApi } from "../core/adapter-api";
import { ConsentError, type Category, type ConsentSignal } from "../core/consent";

/** The page's window, as far as OneTrust goes. */
export interface OneTrustHost {
  OneTrust?: unknown;
  OnetrustActiveGroups?: unknown;
  OptanonWrapper?: unknown;
  addEventListener(type: string, listener: () => void): void;
}

/** The OneTrust group each consent category reads. */
export const ONETRUST_GROUPS: Readonly<Record<Category, string>> = { analytics: "C0002", ads: "C0004" };

/**
 * The signal OneTrust gives, from window.OneTrust and window.OnetrustActiveGroups; undefined while
 * the visitor hasn't answered. Throws ConsentError on a OneTrust that isn't an object or has no
 * IsAlertBoxClosed(), or that has an answer without a string of active groups.
 */
export function oneTrustSignal(oneTrust: unknown, activeGroups: unknown): ConsentSignal | undefined {
  if (typeof oneTrust !== "object" || oneTrust === null) throw new ConsentError("window.OneTrust is not an object");
  const closed = (oneTrust as Record<string, unknown>).IsAlertBoxClosed;
  if (typeof closed !== "function") throw new ConsentError("window.OneTrust.IsAlertBoxClosed is not a function");
  if ((closed as () => unknown).call(oneTrust) !== true) return undefined;
  if (typeof activeGroups !== "string") {
    throw new ConsentError(`window.OnetrustActiveGroups is not a string: ${String(activeGroups)}`);
  }
  const active = activeGroups.split(",");
  const signal: ConsentSignal = {};
  for (const category of ["analytics", "ads"] as const) {
    signal[category] = active.indexOf(ONETRUST_GROUPS[category]) >= 0 ? "granted" : "denied";
  }
  return signal;
}

/**
 * Follows OneTrust on win: its consent now, if the visitor has answered, and each time OneTrust
 * calls OptanonWrapper or fires OneTrustGroupsUpdated after. The site's own OptanonWrapper still
 * runs, after the read, and what it throws or returns stays its own. Each read runs inside the
 * core's boundary (api.guard).
 */
export function watchOneTrust(win: OneTrustHost, api: AdapterApi): void {
  const read = (): void =>
    api.guard(() => {
      if (win.OneTrust === undefined) return;
      const signal = oneTrustSignal(win.OneTrust, win.OnetrustActiveGroups);
      if (signal) api.signal(signal);
    });
  const site = win.OptanonWrapper;
  win.OptanonWrapper = function (this: unknown, ...args: unknown[]): unknown {
    read();
    return typeof site === "function" ? (site as (...a: unknown[]) => unknown).apply(this, args) : undefined;
  };
  win.addEventListener("OneTrustGroupsUpdated", read);
  read();
}
