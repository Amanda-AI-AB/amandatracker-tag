// Cookiebot, for sites whose Cookiebot is set up without Consent Mode or TCF (02 §3.4): the
// cookiebot adapter (src/adapters/cookiebot.ts) reads window.Cookiebot once it connects, and again
// on each CookiebotOnConsentReady, which Cookiebot fires whenever the visitor's consent is ready:
// read from its cookie, given, or changed.
//
// analytics is Cookiebot's `statistics` category, and ads its `marketing` one. A visitor who
// hasn't answered the banner yet (Cookiebot.hasResponse is not true) has decided nothing, whatever
// Cookiebot's categories say meanwhile: the signal is none, and the state stays unknown, never
// assumed granted or denied (08 R11).

import type { AdapterApi } from "../core/adapter-api";
import { ConsentError, type Category, type ConsentSignal } from "../core/consent";

/** The page's window, as far as Cookiebot goes. */
export interface CookiebotHost {
  Cookiebot?: unknown;
  addEventListener(type: string, listener: () => void): void;
}

/** The Cookiebot category each consent category reads. */
export const COOKIEBOT_CATEGORIES: Readonly<Record<Category, string>> = { analytics: "statistics", ads: "marketing" };

/**
 * The signal window.Cookiebot gives; undefined while the visitor hasn't answered. Throws
 * ConsentError on a Cookiebot that isn't an object, or that has an answer without a boolean for
 * each category the tag reads.
 */
export function cookiebotSignal(cookiebot: unknown): ConsentSignal | undefined {
  if (typeof cookiebot !== "object" || cookiebot === null) throw new ConsentError("window.Cookiebot is not an object");
  const bot = cookiebot as Record<string, unknown>;
  if (bot.hasResponse !== true) return undefined;
  const consent = bot.consent;
  if (typeof consent !== "object" || consent === null) throw new ConsentError("window.Cookiebot has a response but no consent");
  const signal: ConsentSignal = {};
  for (const category of ["analytics", "ads"] as const) {
    const key = COOKIEBOT_CATEGORIES[category];
    const value = (consent as Record<string, unknown>)[key];
    if (typeof value !== "boolean") throw new ConsentError(`window.Cookiebot.consent.${key} is not a boolean: ${String(value)}`);
    signal[category] = value ? "granted" : "denied";
  }
  return signal;
}

/**
 * Follows Cookiebot on win: its consent now, if the visitor has answered, and on each
 * CookiebotOnConsentReady after. Each read runs inside the core's boundary (api.guard).
 */
export function watchCookiebot(win: CookiebotHost, api: AdapterApi): void {
  const read = (): void =>
    api.guard(() => {
      if (win.Cookiebot === undefined) return;
      const signal = cookiebotSignal(win.Cookiebot);
      if (signal) api.signal(signal);
    });
  win.addEventListener("CookiebotOnConsentReady", read);
  read();
}
