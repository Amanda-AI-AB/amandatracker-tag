import { describe, expect, it, vi } from "vitest";
import type { AdapterApi } from "../src/core/adapter-api";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import { ConsentError, type ConsentSignal } from "../src/core/consent";
import { oneTrustSignal, watchOneTrust, type OneTrustHost } from "../src/cmp/onetrust";

/** window.OneTrust, its banner answered or not. */
const oneTrust = (answered: boolean) => ({ IsAlertBoxClosed: () => answered });

describe("oneTrustSignal", () => {
  it("reads analytics from group C0002 and ads from C0004 once the visitor answered", () => {
    expect(oneTrustSignal(oneTrust(true), ",C0001,C0002,C0003,C0004,C0005,")).toEqual({ analytics: "granted", ads: "granted" });
    expect(oneTrustSignal(oneTrust(true), ",C0001,")).toEqual({ analytics: "denied", ads: "denied" });
    expect(oneTrustSignal(oneTrust(true), ",C0001,C0002,")).toEqual({ analytics: "granted", ads: "denied" });
    expect(oneTrustSignal(oneTrust(true), "C0001,C0004")).toEqual({ analytics: "denied", ads: "granted" });
  });

  it("matches whole group ids only", () => {
    expect(oneTrustSignal(oneTrust(true), ",C0001,C00021,C00041,")).toEqual({ analytics: "denied", ads: "denied" });
  });

  it("gives no signal before the visitor answered, whatever groups OneTrust holds active by default", () => {
    expect(oneTrustSignal(oneTrust(false), ",C0001,C0002,C0003,C0004,")).toBeUndefined();
    expect(oneTrustSignal(oneTrust(false), undefined)).toBeUndefined();
  });

  it.each([
    ["not an object", "yes", ",C0001,", "window.OneTrust is not an object"],
    ["null", null, ",C0001,", "window.OneTrust is not an object"],
    ["no IsAlertBoxClosed", {}, ",C0001,", "window.OneTrust.IsAlertBoxClosed is not a function"],
    ["an answer without active groups", oneTrust(true), undefined, "window.OnetrustActiveGroups is not a string: undefined"],
    ["active groups that aren't a string", oneTrust(true), ["C0002"], "window.OnetrustActiveGroups is not a string: C0002"],
  ])("throws ConsentError on a OneTrust with %s", (_label, ot, groups, message) => {
    expect(() => oneTrustSignal(ot, groups)).toThrow(new ConsentError(message));
  });
});

describe("watchOneTrust", () => {
  function setup(answered: boolean, groups: unknown, wrapper?: unknown) {
    const listeners: Record<string, (() => void)[]> = {};
    const win: OneTrustHost = {
      OneTrust: oneTrust(answered),
      OnetrustActiveGroups: groups,
      OptanonWrapper: wrapper,
      addEventListener: (type, listener) => (listeners[type] = listeners[type] || []).push(listener),
    };
    const reports: ErrorReport[] = [];
    const boundary = new ErrorBoundary((report) => reports.push(report), 1);
    const signals: ConsentSignal[] = [];
    const api: AdapterApi = { signal: (signal) => signals.push(signal), guard: (fn) => boundary.guard("consent", fn) };
    watchOneTrust(win, api);
    /** OneTrust's visitor answers: the groups change, then OneTrust calls OptanonWrapper. */
    const answer = (active: string): void => {
      win.OneTrust = oneTrust(true);
      win.OnetrustActiveGroups = active;
      (win.OptanonWrapper as () => void)();
    };
    const fire = (type: string): void => (listeners[type] || []).forEach((listener) => listener());
    return { win, signals, reports, answer, fire };
  }

  it("reads an answer given before it connected, then follows accept, reject and change through OptanonWrapper", () => {
    const { signals, answer, reports } = setup(true, ",C0001,");
    expect(signals).toEqual([{ analytics: "denied", ads: "denied" }]);

    answer(",C0001,C0002,C0004,");
    answer(",C0001,C0002,");

    expect(signals).toEqual([
      { analytics: "denied", ads: "denied" },
      { analytics: "granted", ads: "granted" },
      { analytics: "granted", ads: "denied" },
    ]);
    expect(reports).toEqual([]);
  });

  it("waits for the visitor's answer", () => {
    const { signals, answer } = setup(false, ",C0001,C0002,C0004,");
    expect(signals).toEqual([]);

    answer(",C0001,C0004,");
    expect(signals).toEqual([{ analytics: "denied", ads: "granted" }]);
  });

  it("still calls the site's own OptanonWrapper, after reading, with what OneTrust passed, and returns its result", () => {
    let signalsSeen = -1;
    const site = vi.fn(function (this: unknown) {
      signalsSeen = signals.length;
      return "site's";
    });
    const { win, signals } = setup(true, ",C0001,", site);

    win.OnetrustActiveGroups = ",C0001,C0002,";
    const self = { called: "on" };
    expect((win.OptanonWrapper as (...args: unknown[]) => unknown).call(self, "arg")).toBe("site's");
    expect(signalsSeen).toBe(2);
    expect(site.mock.calls).toEqual([["arg"]]);
    expect(site.mock.contexts).toEqual([self]);
  });

  it("leaves what the site's own OptanonWrapper throws to OneTrust, as before", () => {
    const { win, reports } = setup(true, ",C0001,", () => {
      throw new TypeError("site's bug");
    });
    expect(() => (win.OptanonWrapper as () => void)()).toThrow("site's bug");
    expect(reports).toEqual([]);
  });

  it("follows OneTrustGroupsUpdated too, for a site that replaces OptanonWrapper after the hook", () => {
    const { win, signals, fire } = setup(false, ",C0001,");
    win.OptanonWrapper = () => undefined;
    win.OneTrust = oneTrust(true);
    win.OnetrustActiveGroups = ",C0001,C0002,C0004,";
    fire("OneTrustGroupsUpdated");
    expect(signals).toEqual([{ analytics: "granted", ads: "granted" }]);
  });

  it("reports a OneTrust it can't read inside the boundary, never throwing to OneTrust", () => {
    const { win, signals, reports } = setup(false, ",C0001,");
    win.OneTrust = oneTrust(true);
    win.OnetrustActiveGroups = undefined;
    expect(() => (win.OptanonWrapper as () => void)()).not.toThrow();
    expect(signals).toEqual([]);
    expect(reports).toEqual([{ stage: "consent", name: "ConsentError", message: "window.OnetrustActiveGroups is not a string: undefined" }]);
  });
});
