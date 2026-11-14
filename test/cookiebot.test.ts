import { describe, expect, it } from "vitest";
import type { AdapterApi } from "../src/core/adapter-api";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import { ConsentError, type ConsentSignal } from "../src/core/consent";
import { cookiebotSignal, watchCookiebot, type CookiebotHost } from "../src/cmp/cookiebot";

/** window.Cookiebot after the visitor answered, with these categories. */
function answered(statistics: unknown, marketing: unknown): Record<string, unknown> {
  return { hasResponse: true, consented: statistics === true, declined: statistics !== true, consent: { necessary: true, preferences: false, statistics, marketing } };
}

/** window.Cookiebot before the visitor answered: Cookiebot's categories say false meanwhile. */
const UNANSWERED = { hasResponse: false, consented: false, declined: false, consent: { necessary: true, preferences: false, statistics: false, marketing: false } };

describe("cookiebotSignal", () => {
  it("reads analytics from statistics and ads from marketing once the visitor answered", () => {
    expect(cookiebotSignal(answered(true, true))).toEqual({ analytics: "granted", ads: "granted" });
    expect(cookiebotSignal(answered(false, false))).toEqual({ analytics: "denied", ads: "denied" });
    expect(cookiebotSignal(answered(true, false))).toEqual({ analytics: "granted", ads: "denied" });
  });

  it("gives no signal before the visitor answered, so nothing is assumed", () => {
    expect(cookiebotSignal(UNANSWERED)).toBeUndefined();
    expect(cookiebotSignal({ consent: { statistics: true, marketing: true } })).toBeUndefined();
  });

  it.each([
    ["not an object", "yes", "window.Cookiebot is not an object"],
    ["null", null, "window.Cookiebot is not an object"],
    ["an answer without consent", { hasResponse: true }, "window.Cookiebot has a response but no consent"],
    ["a category that isn't a boolean", answered("true", false), "window.Cookiebot.consent.statistics is not a boolean: true"],
    ["a missing category", { hasResponse: true, consent: { statistics: true } }, "window.Cookiebot.consent.marketing is not a boolean: undefined"],
  ])("throws ConsentError on a Cookiebot with %s", (_label, cookiebot, message) => {
    expect(() => cookiebotSignal(cookiebot)).toThrow(new ConsentError(message));
  });
});

describe("watchCookiebot", () => {
  function setup(cookiebot: unknown) {
    const listeners: Record<string, (() => void)[]> = {};
    const win: CookiebotHost = {
      Cookiebot: cookiebot,
      addEventListener: (type, listener) => (listeners[type] = listeners[type] || []).push(listener),
    };
    const reports: ErrorReport[] = [];
    const boundary = new ErrorBoundary((report) => reports.push(report), 1);
    const signals: ConsentSignal[] = [];
    const api: AdapterApi = { signal: (signal) => signals.push(signal), guard: (fn) => boundary.guard("consent", fn) };
    watchCookiebot(win, api);
    const fire = (type: string): void => (listeners[type] || []).forEach((listener) => listener());
    return { win, signals, reports, fire };
  }

  it("reads an answer given before it connected, then follows each consent change", () => {
    const { win, signals, fire, reports } = setup(answered(false, false));
    expect(signals).toEqual([{ analytics: "denied", ads: "denied" }]);

    win.Cookiebot = answered(true, true);
    fire("CookiebotOnConsentReady");
    win.Cookiebot = answered(true, false);
    fire("CookiebotOnConsentReady");

    expect(signals).toEqual([
      { analytics: "denied", ads: "denied" },
      { analytics: "granted", ads: "granted" },
      { analytics: "granted", ads: "denied" },
    ]);
    expect(reports).toEqual([]);
  });

  it("waits for the visitor's answer", () => {
    const { win, signals, fire } = setup(UNANSWERED);
    expect(signals).toEqual([]);

    win.Cookiebot = answered(true, true);
    fire("CookiebotOnConsentReady");
    expect(signals).toEqual([{ analytics: "granted", ads: "granted" }]);
  });

  it("reports a Cookiebot it can't read inside the boundary, never throwing to Cookiebot", () => {
    const { win, signals, fire, reports } = setup(UNANSWERED);
    win.Cookiebot = { hasResponse: true };
    expect(() => fire("CookiebotOnConsentReady")).not.toThrow();
    expect(signals).toEqual([]);
    expect(reports).toEqual([{ stage: "consent", name: "ConsentError", message: "window.Cookiebot has a response but no consent" }]);
  });
});
