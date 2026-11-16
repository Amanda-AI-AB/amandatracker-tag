import { describe, expect, it } from "vitest";
import type { AdapterApi } from "../src/core/adapter-api";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import { ConsentError, type ConsentSignal } from "../src/core/consent";
import { usercentricsSignal, watchUsercentrics, type UsercentricsHost } from "../src/cmp/usercentrics";

/** A getServicesBaseInfo() entry: its category, consent status, and its latest decision's type. */
function service(categorySlug: string, status: boolean, type: "explicit" | "implicit" = "explicit") {
  return { id: `${categorySlug}-${String(status)}`, name: "A service", categorySlug, consent: { status, history: [{ action: "onInitialPageLoad", status: true, type: "implicit" }, { action: "onUpdateServices", status, type }] } };
}

/** window.UC_UI: answered (isConsentRequired() false) or not, with these services. */
function ui(answered: boolean, services: unknown): Record<string, () => unknown> {
  const required: boolean = !answered;
  return { isConsentRequired: () => required, getServicesBaseInfo: () => services };
}

/** The services of a site with Usercentrics' default categories, functional and marketing granted or not. */
const defaults = (functional: boolean, marketing: boolean) => [
  service("essential", true, "implicit"),
  service("functional", functional),
  service("functional", functional),
  service("marketing", marketing),
];

describe("usercentricsSignal", () => {
  it("reads analytics from the functional category and ads from marketing once the visitor answered", () => {
    expect(usercentricsSignal(ui(true, defaults(true, true)))).toEqual({ analytics: "granted", ads: "granted" });
    expect(usercentricsSignal(ui(true, defaults(false, false)))).toEqual({ analytics: "denied", ads: "denied" });
    expect(usercentricsSignal(ui(true, defaults(true, false)))).toEqual({ analytics: "granted", ads: "denied" });
  });

  it("grants a category only when the visitor consented to each of its services", () => {
    const some = [service("functional", true), service("functional", false), service("marketing", true)];
    expect(usercentricsSignal(ui(true, some))).toEqual({ analytics: "denied", ads: "granted" });
  });

  it("denies a category that has no services", () => {
    expect(usercentricsSignal(ui(true, [service("essential", true, "implicit"), service("marketing", true)]))).toEqual({ analytics: "denied", ads: "granted" });
  });

  it("never grants from a service's implicit default", () => {
    const implicit = [service("functional", true, "implicit"), service("marketing", true), service("marketing", true, "implicit")];
    expect(usercentricsSignal(ui(true, implicit))).toEqual({ analytics: "denied", ads: "denied" });
    expect(usercentricsSignal(ui(true, [{ categorySlug: "functional", consent: { status: true, history: [] } }]))).toEqual({ analytics: "denied", ads: "denied" });
  });

  it("gives no signal before the visitor answered, whatever the services' defaults say", () => {
    expect(usercentricsSignal(ui(false, defaults(true, true)))).toBeUndefined();
    expect(usercentricsSignal({ isConsentRequired: () => undefined, getServicesBaseInfo: () => defaults(true, true) })).toBeUndefined();
  });

  it.each([
    ["not an object", "yes", "window.UC_UI is not an object"],
    ["null", null, "window.UC_UI is not an object"],
    ["no isConsentRequired", { getServicesBaseInfo: () => [] }, "window.UC_UI.isConsentRequired is not a function"],
    ["no getServicesBaseInfo", { isConsentRequired: () => false }, "window.UC_UI.getServicesBaseInfo is not a function"],
    ["services that aren't an array", ui(true, {}), "window.UC_UI.getServicesBaseInfo() is not an array"],
    ["a service without a category", ui(true, [{ consent: { status: true, history: [] } }]), "window.UC_UI.getServicesBaseInfo()[0].categorySlug is not a string: undefined"],
    ["a service without consent", ui(true, [service("marketing", true), { categorySlug: "functional" }]), "window.UC_UI.getServicesBaseInfo()[1] has no consent"],
    ["a status that isn't a boolean", ui(true, [{ categorySlug: "functional", consent: { status: "true", history: [] } }]), "window.UC_UI.getServicesBaseInfo()[0].consent.status is not a boolean: true"],
    ["a history that isn't an array", ui(true, [{ categorySlug: "functional", consent: { status: true } }]), "window.UC_UI.getServicesBaseInfo()[0].consent.history is not an array"],
  ])("throws ConsentError on a UC_UI with %s", (_label, uc, message) => {
    expect(() => usercentricsSignal(uc)).toThrow(new ConsentError(message));
  });
});

describe("watchUsercentrics", () => {
  function setup(uc: unknown) {
    const listeners: Record<string, (() => void)[]> = {};
    const win: UsercentricsHost = {
      UC_UI: uc,
      addEventListener: (type, listener) => (listeners[type] = listeners[type] || []).push(listener),
    };
    const reports: ErrorReport[] = [];
    const boundary = new ErrorBoundary((report) => reports.push(report), 1);
    const signals: ConsentSignal[] = [];
    const api: AdapterApi = { signal: (signal) => signals.push(signal), guard: (fn) => boundary.guard("consent", fn) };
    watchUsercentrics(win, api);
    const fire = (type: string): void => (listeners[type] || []).forEach((listener) => listener());
    return { win, signals, reports, fire };
  }

  it("reads an answer given before it connected, then follows accept, reject and change on UC_UI_CMP_EVENT", () => {
    const { win, signals, fire, reports } = setup(ui(true, defaults(false, false)));
    expect(signals).toEqual([{ analytics: "denied", ads: "denied" }]);

    win.UC_UI = ui(true, defaults(true, true));
    fire("UC_UI_CMP_EVENT");
    win.UC_UI = ui(true, defaults(true, false));
    fire("UC_UI_CMP_EVENT");

    expect(signals).toEqual([
      { analytics: "denied", ads: "denied" },
      { analytics: "granted", ads: "granted" },
      { analytics: "granted", ads: "denied" },
    ]);
    expect(reports).toEqual([]);
  });

  it("waits for the visitor's answer, and reads once Usercentrics is initialized", () => {
    const { win, signals, fire } = setup(undefined);
    expect(signals).toEqual([]);

    win.UC_UI = ui(false, defaults(true, true));
    fire("UC_UI_INITIALIZED");
    expect(signals).toEqual([]);

    win.UC_UI = ui(true, defaults(false, true));
    fire("UC_UI_CMP_EVENT");
    expect(signals).toEqual([{ analytics: "denied", ads: "granted" }]);
  });

  it("reports a UC_UI it can't read inside the boundary, never throwing to Usercentrics", () => {
    const { win, signals, reports, fire } = setup(ui(false, []));
    win.UC_UI = ui(true, "not a list");
    expect(() => fire("UC_UI_CMP_EVENT")).not.toThrow();
    expect(signals).toEqual([]);
    expect(reports).toEqual([{ stage: "consent", name: "ConsentError", message: "window.UC_UI.getServicesBaseInfo() is not an array" }]);
  });
});
