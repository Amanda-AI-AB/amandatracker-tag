import { describe, expect, it } from "vitest";
import type { AdapterApi } from "../src/core/adapter-api";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import { ConsentError, type ConsentSignal } from "../src/core/consent";
import { usercentricsSignal, usercentricsV3Signal, watchUsercentrics, type UsercentricsHost } from "../src/cmp/usercentrics";

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

/** A v3 ConsentDetails service: its category, and its consent, given or not, explicit or implicit. */
function v3Service(category: string, given: boolean, type: "EXPLICIT" | "IMPLICIT" = "EXPLICIT") {
  return { name: "A service", version: "1.0.0", category, essential: false, consent: { given, type } };
}

/**
 * A v3 ConsentDetails, shaped as https://usercentrics.com/docs/web/features/api/interfaces/#consentdetails
 * gives it: answered (consent.required false) or not, with these services by ID.
 */
function details(answered: boolean, services: Record<string, unknown>) {
  return {
    consent: {
      status: "SOME_ACCEPTED",
      required: !answered,
      version: 1,
      controllerId: "CONTROLLER_ID",
      language: "en",
      createdAt: 1750000000000,
      updatedAt: 1750000000000,
      updatedBy: answered ? "onUpdateServices" : "onInitialPageLoad",
      setting: { id: "SETTINGS_ID", type: "GDPR", version: "1.0.0" },
      type: answered ? "EXPLICIT" : "IMPLICIT",
      hash: "CONSENT_HASH",
    },
    services,
    categories: {},
  };
}

/** A v3 site's services with the default categories, functional and marketing granted or not. */
const v3Defaults = (functional: boolean, marketing: boolean) => ({
  essential1: v3Service("essential", true, "IMPLICIT"),
  functional1: v3Service("functional", functional),
  functional2: v3Service("functional", functional),
  marketing1: v3Service("marketing", marketing),
});

const WHERE = "window.__ucCmp.getConsentDetails()";

describe("usercentricsV3Signal", () => {
  it("reads analytics from the functional category and ads from marketing once the visitor answered", () => {
    expect(usercentricsV3Signal(details(true, v3Defaults(true, true)), WHERE)).toEqual({ analytics: "granted", ads: "granted" });
    expect(usercentricsV3Signal(details(true, v3Defaults(false, false)), WHERE)).toEqual({ analytics: "denied", ads: "denied" });
    expect(usercentricsV3Signal(details(true, v3Defaults(true, false)), WHERE)).toEqual({ analytics: "granted", ads: "denied" });
  });

  it("grants a category only when the visitor consented to each of its services, and denies one without services", () => {
    const some = { a: v3Service("functional", true), b: v3Service("functional", false), c: v3Service("marketing", true) };
    expect(usercentricsV3Signal(details(true, some), WHERE)).toEqual({ analytics: "denied", ads: "granted" });
    expect(usercentricsV3Signal(details(true, { c: v3Service("marketing", true) }), WHERE)).toEqual({ analytics: "denied", ads: "granted" });
  });

  it("never grants from an implicit consent, or a service without one", () => {
    const implicit = { a: v3Service("functional", true, "IMPLICIT"), b: v3Service("marketing", true), c: v3Service("marketing", true, "IMPLICIT") };
    expect(usercentricsV3Signal(details(true, implicit), WHERE)).toEqual({ analytics: "denied", ads: "denied" });
    expect(usercentricsV3Signal(details(true, { a: { category: "functional" } }), WHERE)).toEqual({ analytics: "denied", ads: "denied" });
  });

  it("gives no signal before the visitor answered, whatever the services' defaults say", () => {
    expect(usercentricsV3Signal(details(false, v3Defaults(true, true)), WHERE)).toBeUndefined();
  });

  it.each([
    ["not an object", "yes", `${WHERE} is not an object`],
    ["no consent", { services: {} }, `${WHERE}.consent is not an object`],
    ["a required that isn't a boolean", { consent: {}, services: {} }, `${WHERE}.consent.required is not a boolean: undefined`],
    ["services that aren't an object", { consent: { required: false }, services: [] }, `${WHERE}.services is not an object`],
    ["a service that isn't an object", details(true, { a: null }), `${WHERE}.services["a"] is not an object`],
    ["a service without a category", details(true, { a: { consent: { given: true, type: "EXPLICIT" } } }), `${WHERE}.services["a"].category is not a string: undefined`],
    ["a consent that isn't an object", details(true, { a: { category: "functional", consent: true } }), `${WHERE}.services["a"].consent is not an object`],
    ["a given that isn't a boolean", details(true, { a: { category: "functional", consent: { given: "true", type: "EXPLICIT" } } }), `${WHERE}.services["a"].consent.given is not a boolean: true`],
    ["an unknown consent type", details(true, { a: { category: "functional", consent: { given: true, type: "explicit" } } }), `${WHERE}.services["a"].consent.type is not EXPLICIT or IMPLICIT: explicit`],
  ])("throws ConsentError on ConsentDetails with %s", (_label, value, message) => {
    expect(() => usercentricsV3Signal(value, WHERE)).toThrow(new ConsentError(message));
  });
});

describe("watchUsercentrics", () => {
  function setup(uc: unknown, ucCmp?: unknown) {
    const listeners: Record<string, ((event?: unknown) => void)[]> = {};
    const win: UsercentricsHost = {
      UC_UI: uc,
      __ucCmp: ucCmp,
      addEventListener: (type, listener) => (listeners[type] = listeners[type] || []).push(listener),
    };
    const reports: ErrorReport[] = [];
    const boundary = new ErrorBoundary((report) => reports.push(report), 1);
    const signals: ConsentSignal[] = [];
    const api: AdapterApi = { signal: (signal) => signals.push(signal), guard: (fn) => boundary.guard("consent", fn) };
    watchUsercentrics(win, api);
    const fire = (type: string, event?: unknown): void => (listeners[type] || []).forEach((listener) => listener(event));
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

  describe("v3, window.__ucCmp", () => {
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    /** window.__ucCmp: initialized or not, resolving getConsentDetails() to `current()`. */
    function ucCmp(initialized: boolean, current: () => unknown) {
      return { isInitialized: async () => initialized, getConsentDetails: async () => current() };
    }

    it("reads an answer given before it connected, then follows accept, reject and change on UC_CONSENT", async () => {
      const { signals, fire, reports } = setup(undefined, ucCmp(true, () => details(true, v3Defaults(false, false))));
      await flush();
      expect(signals).toEqual([{ analytics: "denied", ads: "denied" }]);

      fire("UC_CONSENT", { detail: details(true, v3Defaults(true, true)) });
      fire("UC_CONSENT", { detail: details(true, v3Defaults(true, false)) });

      expect(signals).toEqual([
        { analytics: "denied", ads: "denied" },
        { analytics: "granted", ads: "granted" },
        { analytics: "granted", ads: "denied" },
      ]);
      expect(reports).toEqual([]);
    });

    it("waits for the visitor's answer, and for __ucCmp to be initialized", async () => {
      let current = details(false, v3Defaults(true, true));
      const cmp = ucCmp(false, () => current);
      const { win, signals, fire } = setup(undefined, cmp);
      await flush();
      expect(signals).toEqual([]);

      win.__ucCmp = ucCmp(true, () => current);
      fire("UC_UI_INITIALIZED");
      await flush();
      fire("UC_CONSENT", { detail: current });
      expect(signals).toEqual([]);

      current = details(true, v3Defaults(false, true));
      fire("UC_CONSENT", { detail: current });
      expect(signals).toEqual([{ analytics: "denied", ads: "granted" }]);
    });

    it("drops a read that resolves after a newer UC_CONSENT", async () => {
      const { signals, fire } = setup(undefined, ucCmp(true, () => details(true, v3Defaults(true, true))));
      fire("UC_CONSENT", { detail: details(true, v3Defaults(false, false)) });
      await flush();
      expect(signals).toEqual([{ analytics: "denied", ads: "denied" }]);
    });

    it("follows v3 alone on a page that also has UC_UI", async () => {
      const { signals, fire } = setup(ui(true, defaults(true, true)), ucCmp(true, () => details(true, v3Defaults(false, false))));
      await flush();
      expect(signals).toEqual([{ analytics: "denied", ads: "denied" }]);

      fire("UC_UI_CMP_EVENT");
      await flush();
      expect(signals).toEqual([
        { analytics: "denied", ads: "denied" },
        { analytics: "denied", ads: "denied" },
      ]);
    });

    it("ignores UC_CONSENT on a page without __ucCmp", () => {
      const { signals, fire, reports } = setup(undefined);
      fire("UC_CONSENT", { detail: "not consent details" });
      expect(signals).toEqual([]);
      expect(reports).toEqual([]);
    });

    it("reports a __ucCmp it can't read, and a rejected promise, inside the boundary", async () => {
      const failing = { isInitialized: async () => true, getConsentDetails: () => Promise.reject(new TypeError("boom")) };
      const { win, signals, reports, fire } = setup(undefined, failing);
      await flush();

      win.__ucCmp = { isInitialized: async () => "yes", getConsentDetails: async () => undefined };
      fire("UC_UI_INITIALIZED");
      await flush();
      win.__ucCmp = { isInitialized: async () => true };
      fire("UC_UI_INITIALIZED");
      await flush();
      win.__ucCmp = "not an object";
      expect(() => fire("UC_UI_INITIALIZED")).not.toThrow();

      expect(signals).toEqual([]);
      expect(reports).toEqual([
        { stage: "consent", name: "TypeError", message: "boom" },
        { stage: "consent", name: "ConsentError", message: "window.__ucCmp.isInitialized() is not a boolean: yes" },
        { stage: "consent", name: "ConsentError", message: "window.__ucCmp.getConsentDetails is not a function" },
        { stage: "consent", name: "ConsentError", message: "window.__ucCmp is not an object" },
      ]);
    });

    it("reports a UC_CONSENT detail it can't read inside the boundary, never throwing to Usercentrics", async () => {
      const { signals, reports, fire } = setup(undefined, ucCmp(false, () => undefined));
      await flush();
      expect(() => fire("UC_CONSENT", { detail: { consent: {} } })).not.toThrow();
      expect(() => fire("UC_CONSENT")).not.toThrow();

      expect(signals).toEqual([]);
      expect(reports).toEqual([
        { stage: "consent", name: "ConsentError", message: "UC_CONSENT's event.detail.consent.required is not a boolean: undefined" },
        { stage: "consent", name: "ConsentError", message: "UC_CONSENT's event.detail is not an object" },
      ]);
    });
  });
});
