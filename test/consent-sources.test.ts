import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import { ConsentError, createConsent, type Consent, type ConsentMachine } from "../src/core/consent";
import {
  ConsentModeState,
  consentCommand,
  createLadder,
  isDefinitive,
  manualSignal,
  watchConsentMode,
  type ConsentLadder,
  type ConsentModeHost,
} from "../src/core/consent-sources";

/** gtag(...args) on layer: pushes its arguments object, as Google's snippet does. */
function gtag(layer: unknown[], ...args: unknown[]): void {
  const snippetGtag = function (..._args: unknown[]): void {
    layer.push(arguments);
  };
  snippetGtag(...args);
}

interface Harness {
  machine: ConsentMachine<number>;
  ladder: ConsentLadder;
  identified: Consent[];
}

function harness(): Harness {
  const identified: Consent[] = [];
  const machine = createConsent<number>({
    declinedMode: "off",
    sink: { identified: (_item, consent) => identified.push(consent), anonymous: () => undefined, withdraw: () => undefined },
    identity: { forget: () => undefined, renew: () => undefined },
  });
  return { machine, ladder: createLadder(machine), identified };
}

function boundary(): { boundary: ErrorBoundary; reports: ErrorReport[] } {
  const reports: ErrorReport[] = [];
  return { boundary: new ErrorBoundary((report) => reports.push(report), 1), reports };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isDefinitive", () => {
  it("is true when a category is granted or denied, and only then", () => {
    expect(isDefinitive({ analytics: "granted" })).toBe(true);
    expect(isDefinitive({ ads: "denied" })).toBe(true);
    expect(isDefinitive({})).toBe(false);
    expect(isDefinitive({ analytics: "unknown", ads: "no_cmp" })).toBe(false);
  });
});

describe("the ladder", () => {
  it("lets the first definitive signal win, and names its source in the snapshot", () => {
    const { machine, ladder } = harness();
    expect(ladder.active()).toBeUndefined();

    expect(ladder.signal("gcm", { analytics: "denied", ads: "denied" })).toBe(true);

    expect(ladder.active()).toBe("gcm");
    expect(machine.snapshot()).toEqual({ analytics: "denied", ads: "denied", source: "gcm" });
  });

  it("ignores a signal that decides nothing: it neither wins nor changes the state", () => {
    const { machine, ladder } = harness();
    expect(ladder.signal("gcm", {})).toBe(false);
    expect(ladder.active()).toBeUndefined();
    expect(machine.snapshot()).toEqual({ analytics: "unknown", ads: "unknown" });
  });

  it("always applies the winner's later signals, mid-session", () => {
    const { machine, ladder } = harness();
    ladder.signal("gcm", { analytics: "denied" });
    expect(ladder.signal("gcm", { analytics: "granted", ads: "granted" })).toBe(true);
    expect(machine.mode()).toBe("identified");
    expect(ladder.signal("gcm", { analytics: "denied" })).toBe(true);
    expect(machine.mode()).toBe("declined");
  });

  it("lets the manual API take over from Consent Mode, which then no longer moves the state", () => {
    const { machine, ladder } = harness();
    ladder.signal("gcm", { analytics: "denied", ads: "denied" });

    expect(ladder.signal("manual", { analytics: "granted" })).toBe(true);
    expect(ladder.active()).toBe("manual");
    expect(machine.snapshot()).toEqual({ analytics: "granted", ads: "denied", source: "manual" });

    expect(ladder.signal("gcm", { analytics: "denied" })).toBe(false);
    expect(machine.snapshot()).toEqual({ analytics: "granted", ads: "denied", source: "manual" });
  });

  it("never lets Consent Mode take over from the manual API", () => {
    const { machine, ladder } = harness();
    ladder.signal("manual", { analytics: "denied", ads: "denied" });
    expect(ladder.signal("gcm", { analytics: "granted", ads: "granted" })).toBe(false);
    expect(machine.snapshot()).toEqual({ analytics: "denied", ads: "denied", source: "manual" });
  });

  it("flushes the pending buffer under the winning source's snapshot", () => {
    const { machine, ladder, identified } = harness();
    machine.collect(1);
    ladder.signal("gcm", { analytics: "granted", ads: "denied" });
    expect(identified).toEqual([{ analytics: "granted", ads: "denied", source: "gcm" }]);
  });
});

describe("the manual API", () => {
  it("takes analytics and ads, each granted or denied", () => {
    expect(manualSignal({ analytics: "granted", ads: "denied" })).toEqual({ analytics: "granted", ads: "denied" });
    expect(manualSignal({ ads: "granted" })).toEqual({ ads: "granted" });
  });

  it.each([
    ["not an object", "granted"],
    ["null", null],
    ["an array", ["granted"]],
    ["nothing decided", {}],
    ["another category", { analytics: "granted", functional: "granted" }],
    ["unknown", { analytics: "unknown" }],
    ["no_cmp", { analytics: "no_cmp" }],
    ["a boolean", { analytics: true }],
    ["undefined", { analytics: undefined }],
  ])("refuses %s, and never assumes a signal", (_name, value) => {
    expect(() => manualSignal(value)).toThrow(ConsentError);
  });

  it("drives the machine through the consent command", () => {
    const { machine, ladder } = harness();
    consentCommand(ladder)({ analytics: "granted", ads: "granted" });
    expect(machine.snapshot()).toEqual({ analytics: "granted", ads: "granted", source: "manual" });
  });

  it("changes nothing when the command is refused", () => {
    const { machine, ladder } = harness();
    expect(() => consentCommand(ladder)({ analytics: "yes" })).toThrow(ConsentError);
    expect(ladder.active()).toBeUndefined();
    expect(machine.snapshot()).toEqual({ analytics: "unknown", ads: "unknown" });
  });
});

describe("Consent Mode's state", () => {
  it("maps analytics_storage to analytics", () => {
    const gcm = new ConsentModeState();
    expect(gcm.read(["consent", "default", { analytics_storage: "denied" }])).toBe(true);
    expect(gcm.signal()).toEqual({ analytics: "denied" });
  });

  it.each([
    ["granted", "granted", "granted"],
    ["granted", "denied", "denied"],
    ["denied", "granted", "denied"],
    ["granted", undefined, undefined],
    [undefined, "granted", undefined],
    [undefined, "denied", "denied"],
  ] as const)("ad_storage %s and ad_user_data %s give ads %s", (storage, userData, ads) => {
    const gcm = new ConsentModeState();
    gcm.read(["consent", "update", { ad_storage: storage, ad_user_data: userData }]);
    expect(gcm.signal().ads).toBe(ads);
  });

  it("leaves out what it doesn't decide: ad_personalization and the other types change nothing", () => {
    const gcm = new ConsentModeState();
    expect(gcm.read(["consent", "default", { ad_personalization: "granted", functionality_storage: "granted" }])).toBe(false);
    expect(gcm.signal()).toEqual({});
  });

  it("lets an update override the default, and a later default never override an update", () => {
    const gcm = new ConsentModeState();
    gcm.read(["consent", "default", { analytics_storage: "denied" }]);
    gcm.read(["consent", "update", { analytics_storage: "granted" }]);
    expect(gcm.signal()).toEqual({ analytics: "granted" });
    expect(gcm.read(["consent", "default", { analytics_storage: "denied" }])).toBe(false);
    expect(gcm.signal()).toEqual({ analytics: "granted" });
  });

  it("skips a default scoped to regions: the visitor's region is not known", () => {
    const gcm = new ConsentModeState();
    expect(gcm.read(["consent", "default", { analytics_storage: "granted", region: ["US"] }])).toBe(false);
    expect(gcm.signal()).toEqual({});
  });

  it("ignores what is not a consent default or update", () => {
    const gcm = new ConsentModeState();
    for (const entry of [
      { event: "gtm.js" },
      null,
      "consent",
      ["config", "G-XXXX"],
      ["consent", "set", { analytics_storage: "granted" }],
    ]) {
      expect(gcm.read(entry)).toBe(false);
    }
    expect(gcm.signal()).toEqual({});
  });

  it("warns about, and ignores, a state other than granted or denied, or missing parameters", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const gcm = new ConsentModeState();
    expect(gcm.read(["consent", "update", { analytics_storage: "yes" }])).toBe(false);
    expect(gcm.read(["consent", "update"])).toBe(false);
    expect(gcm.signal()).toEqual({});
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("watchConsentMode", () => {
  it("reads the state already in the dataLayer as one signal", () => {
    const { machine, ladder } = harness();
    const update = vi.spyOn(machine, "update");
    const win: ConsentModeHost = {
      dataLayer: [
        ["consent", "default", { analytics_storage: "denied", ad_storage: "denied", ad_user_data: "denied" }],
        { event: "gtm.js" },
        ["consent", "update", { analytics_storage: "granted" }],
      ],
    };

    watchConsentMode(win, boundary().boundary, ladder);

    expect(update).toHaveBeenCalledTimes(1);
    expect(machine.snapshot()).toEqual({ analytics: "granted", ads: "denied", source: "gcm" });
  });

  it("follows the updates pushed later, mid-session, and still hands them to the dataLayer", () => {
    const { machine, ladder } = harness();
    const layer: unknown[] = [];
    const win: ConsentModeHost = { dataLayer: layer };
    watchConsentMode(win, boundary().boundary, ladder);
    expect(ladder.active()).toBeUndefined();

    gtag(layer, "consent", "default", { analytics_storage: "denied" });
    expect(machine.mode()).toBe("declined");
    gtag(layer, "consent", "update", { analytics_storage: "granted", ad_storage: "granted", ad_user_data: "granted" });

    expect(machine.snapshot()).toEqual({ analytics: "granted", ads: "granted", source: "gcm" });
    expect(layer).toHaveLength(2);
  });

  it("returns the page's push's result, and calls it on the dataLayer", () => {
    const { ladder } = harness();
    const layer: unknown[] = [];
    const push = vi.spyOn(layer, "push");
    watchConsentMode({ dataLayer: layer }, boundary().boundary, ladder);

    expect(layer.push({ event: "a" }, { event: "b" })).toBe(2);
    expect(push).toHaveBeenCalledWith({ event: "a" }, { event: "b" });
    expect(push.mock.contexts[0]).toBe(layer);
  });

  it("defines the dataLayer when the page has none, so a gtag loaded later is followed", () => {
    const { machine, ladder } = harness();
    const win: ConsentModeHost = {};
    watchConsentMode(win, boundary().boundary, ladder);

    expect(Array.isArray(win.dataLayer)).toBe(true);
    gtag(win.dataLayer as unknown[], "consent", "update", { analytics_storage: "granted" });
    expect(machine.snapshot()).toEqual({ analytics: "granted", ads: "unknown", source: "gcm" });
  });

  it("refuses a dataLayer that isn't an array", () => {
    const { ladder } = harness();
    expect(() => watchConsentMode({ dataLayer: {} }, boundary().boundary, ladder)).toThrow(ConsentError);
  });

  it("reports a failure while reading a push, and never throws it at whoever pushed", () => {
    const failing: ConsentLadder = {
      active: () => undefined,
      signal: () => {
        throw new Error("broken");
      },
    };
    const layer: unknown[] = [];
    const { boundary: b, reports } = boundary();
    watchConsentMode({ dataLayer: layer }, b, failing);

    expect(() => gtag(layer, "consent", "update", { analytics_storage: "granted" })).not.toThrow();
    expect(layer).toHaveLength(1);
    expect(reports).toEqual([{ stage: "consent", name: "Error", message: "broken" }]);
  });

  it("gives way to the manual API, whose signals Consent Mode then can't undo", () => {
    const { machine, ladder } = harness();
    const layer: unknown[] = [["consent", "default", { analytics_storage: "granted" }]];
    watchConsentMode({ dataLayer: layer }, boundary().boundary, ladder);

    consentCommand(ladder)({ analytics: "denied" });
    gtag(layer, "consent", "update", { analytics_storage: "granted" });

    expect(machine.snapshot()).toEqual({ analytics: "denied", ads: "unknown", source: "manual" });
  });
});
