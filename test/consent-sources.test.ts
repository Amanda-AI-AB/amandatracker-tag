import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import { ConsentError, createConsent, type Consent, type ConsentMachine } from "../src/core/consent";
import {
  ConsentModeState,
  consentCommand,
  createLadder,
  gpcEnabled,
  honorGpc,
  isDefinitive,
  manualSignal,
  tcfSignal,
  watchConsentMode,
  watchTcf,
  type ConsentLadder,
  type ConsentModeHost,
} from "../src/core/consent-sources";
import { buildEvent } from "../src/wire/payload";
import { EVENT, validator } from "./wire-validator";

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

describe("Global Privacy Control", () => {
  const browser = (globalPrivacyControl?: unknown) => ({ navigator: { globalPrivacyControl } });

  it("counts only a literal true as GPC", () => {
    expect(gpcEnabled(browser(true))).toBe(true);
    for (const value of [undefined, false, "1", 1, null]) expect(gpcEnabled(browser(value))).toBe(false);
  });

  it("denies both categories when the browser sends it, naming gpc as the source", () => {
    const { machine, ladder } = harness();
    expect(honorGpc(browser(true), ladder)).toBe(true);
    expect(ladder.active()).toBe("gpc");
    expect(machine.snapshot()).toEqual({ analytics: "denied", ads: "denied", source: "gpc" });
    expect(machine.mode()).toBe("declined");
  });

  it("does nothing when the browser doesn't send it", () => {
    const { machine, ladder } = harness();
    expect(honorGpc(browser(false), ladder)).toBe(false);
    expect(ladder.active()).toBeUndefined();
    expect(machine.snapshot()).toEqual({ analytics: "unknown", ads: "unknown" });
  });

  it("ignores legacy Do Not Track", () => {
    const { machine, ladder } = harness();
    expect(honorGpc({ navigator: { doNotTrack: "1" } } as never, ladder)).toBe(false);
    expect(machine.snapshot()).toEqual({ analytics: "unknown", ads: "unknown" });
  });

  it("lets neither the manual API nor Consent Mode grant anything after it", () => {
    const { machine, ladder } = harness();
    honorGpc(browser(true), ladder);
    expect(ladder.signal("gcm", { analytics: "granted", ads: "granted" })).toBe(false);
    expect(ladder.signal("manual", { analytics: "granted", ads: "granted" })).toBe(false);
    expect(machine.snapshot()).toEqual({ analytics: "denied", ads: "denied", source: "gpc" });
  });

  it("takes over from a source that granted first", () => {
    const { machine, ladder } = harness();
    ladder.signal("gcm", { analytics: "granted", ads: "granted" });
    honorGpc(browser(true), ladder);
    expect(machine.snapshot()).toEqual({ analytics: "denied", ads: "denied", source: "gpc" });
  });

  it("warns when it overrules amanda('consent', ...), which then changes nothing", () => {
    const { machine, ladder } = harness();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    honorGpc(browser(true), ladder);
    consentCommand(ladder)({ analytics: "granted" });
    expect(machine.snapshot()).toEqual({ analytics: "denied", ads: "denied", source: "gpc" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Global Privacy Control"));
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

/** A TC string: a core segment and a disclosed-vendors one. */
const TC_ACCEPT = "CQBnS0AQBnS0AAHABBENBJFsAP_gAEPgAAqIg1NX_H__bW9r8X7_aft0eY1P9_j77sQxBhfJE-4F3LvW_JwXx2E5NF36tqoKmRoEu3ZBIUNlHJHUTVmwaogVryHsakWcoTNKJ6BkkFMRM2dYCF5vm4tjeQKY5_p_d3fx2D-t_dv839zzz8VHn3e5fue0-PCdU5-9Dfn9fRfb-9IL9_78v8v8_9_rk2_eT13_79_7_H9-f_87_AA";
const TC_REJECT = "CQBnS0AQBnS0AAHABBENBJFgAAAAAAAAAAqIAAAAAAAA.YAAAAAAAAAAA";

/** A TCF v2.2 consent manager's __tcfapi, as far as addEventListener goes. */
class FakeCmp {
  readonly listeners: Array<(tcData: unknown, success: boolean) => void> = [];
  readonly calls: unknown[][] = [];
  readonly __tcfapi = (command: string, version: number, callback: (tcData: unknown, success: boolean) => void): void => {
    this.calls.push([command, version]);
    if (command === "addEventListener") this.listeners.push(callback);
  };

  /** Calls every listener back with TCData, as the consent manager does on load and on each change. */
  emit(tcData: unknown, success = true): void {
    for (const listener of this.listeners) listener(tcData, success);
  }
}

/** TCData with consent to the purposes listed. */
function tcData(eventStatus: string, purposes: number[], tcString?: string): Record<string, unknown> {
  const consents: Record<string, boolean> = {};
  for (let id = 1; id <= 11; id++) consents[id] = purposes.indexOf(id) >= 0;
  return { tcString, eventStatus, gdprApplies: true, listenerId: 1, purpose: { consents, legitimateInterests: {} } };
}

describe("TCF's signal", () => {
  it.each([
    ["purposes 1, 7 and 8", [1, 7, 8], { analytics: "granted", ads: "granted" }],
    ["purposes 1 and 8", [1, 8], { analytics: "granted", ads: "denied" }],
    ["purposes 1 and 7", [1, 7], { analytics: "denied", ads: "granted" }],
    ["purposes 7 and 8 without 1", [7, 8], { analytics: "denied", ads: "denied" }],
    ["no purpose", [], { analytics: "denied", ads: "denied" }],
  ] as const)("maps consent to %s", (_name, purposes, signal) => {
    expect(tcfSignal(tcData("useractioncomplete", [...purposes], TC_ACCEPT))).toEqual({ signal, tcString: TC_ACCEPT });
  });

  it("decides on tcloaded, a returning visitor's stored consent", () => {
    expect(tcfSignal(tcData("tcloaded", [1, 7, 8]))).toEqual({ signal: { analytics: "granted", ads: "granted" } });
  });

  it("counts only a literal true as consent", () => {
    const data = tcData("useractioncomplete", []);
    data.purpose = { consents: { 1: "true", 7: 1, 8: true } };
    expect(tcfSignal(data)!.signal).toEqual({ analytics: "denied", ads: "denied" });
  });

  it("gives no signal while the visitor is still deciding, or where GDPR doesn't apply", () => {
    expect(tcfSignal(tcData("cmpuishown", [1, 7, 8], TC_ACCEPT))).toBeUndefined();
    expect(tcfSignal({ ...tcData("tcloaded", [1, 7, 8]), gdprApplies: false })).toBeUndefined();
  });

  it("leaves out an empty TC string", () => {
    expect(tcfSignal(tcData("tcloaded", [1], ""))).toEqual({ signal: { analytics: "denied", ads: "denied" } });
  });

  it.each([
    ["not an object", null],
    ["an unknown eventStatus", { ...tcData("tcloaded", []), eventStatus: "done" }],
    ["no purpose consents", { ...tcData("tcloaded", []), purpose: {} }],
  ])("refuses TCData that is %s", (_name, data) => {
    expect(() => tcfSignal(data)).toThrow(ConsentError);
  });
});

describe("watchTcf", () => {
  it("does nothing on a page without __tcfapi", () => {
    const { ladder } = harness();
    expect(watchTcf({}, boundary().boundary, ladder)).toBe(false);
  });

  it("listens with addEventListener, version 2", () => {
    const { ladder } = harness();
    const cmp = new FakeCmp();
    expect(watchTcf(cmp, boundary().boundary, ladder)).toBe(true);
    expect(cmp.calls).toEqual([["addEventListener", 2]]);
  });

  it("drives the machine on accept, carrying the TC string in the snapshot", () => {
    const { machine, ladder, identified } = harness();
    const cmp = new FakeCmp();
    watchTcf(cmp, boundary().boundary, ladder);
    machine.collect(1);

    cmp.emit(tcData("cmpuishown", []));
    expect(machine.mode()).toBe("pending");
    cmp.emit(tcData("useractioncomplete", [1, 7, 8], TC_ACCEPT));

    const accepted = { analytics: "granted", ads: "granted", source: "tcf", tc_string: TC_ACCEPT };
    expect(machine.snapshot()).toEqual(accepted);
    expect(identified).toEqual([accepted]);
  });

  it("drives the machine on reject", () => {
    const { machine, ladder } = harness();
    const cmp = new FakeCmp();
    watchTcf(cmp, boundary().boundary, ladder);

    cmp.emit(tcData("useractioncomplete", [], TC_REJECT));

    expect(machine.mode()).toBe("declined");
    expect(machine.snapshot()).toEqual({ analytics: "denied", ads: "denied", source: "tcf", tc_string: TC_REJECT });
  });

  it("follows a change mid-session, the snapshot taking the new TC string", () => {
    const { machine, ladder } = harness();
    const cmp = new FakeCmp();
    watchTcf(cmp, boundary().boundary, ladder);

    cmp.emit(tcData("tcloaded", [1, 7, 8], TC_ACCEPT));
    expect(machine.mode()).toBe("identified");
    cmp.emit(tcData("useractioncomplete", [1, 8], TC_REJECT));
    expect(machine.snapshot()).toEqual({ analytics: "granted", ads: "denied", source: "tcf", tc_string: TC_REJECT });
    cmp.emit(tcData("useractioncomplete", []));

    expect(machine.mode()).toBe("declined");
    expect(machine.snapshot()).toEqual({ analytics: "denied", ads: "denied", source: "tcf" });
  });

  it("gives way to Consent Mode and the manual API, and the TC string goes with it", () => {
    const { machine, ladder } = harness();
    const cmp = new FakeCmp();
    watchTcf(cmp, boundary().boundary, ladder);
    cmp.emit(tcData("tcloaded", [1, 7, 8], TC_ACCEPT));

    expect(ladder.signal("gcm", { analytics: "granted", ads: "denied" })).toBe(true);
    expect(machine.snapshot()).toEqual({ analytics: "granted", ads: "denied", source: "gcm" });

    cmp.emit(tcData("useractioncomplete", [], TC_REJECT));
    expect(machine.snapshot()).toEqual({ analytics: "granted", ads: "denied", source: "gcm" });
  });

  it("never takes over from GPC", () => {
    const { machine, ladder } = harness();
    const cmp = new FakeCmp();
    honorGpc({ navigator: { globalPrivacyControl: true } }, ladder);
    watchTcf(cmp, boundary().boundary, ladder);

    cmp.emit(tcData("useractioncomplete", [1, 7, 8], TC_ACCEPT));

    expect(machine.snapshot()).toEqual({ analytics: "denied", ads: "denied", source: "gpc" });
  });

  it("warns about a callback that reports failure, and changes nothing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { machine, ladder } = harness();
    const cmp = new FakeCmp();
    watchTcf(cmp, boundary().boundary, ladder);

    cmp.emit(tcData("useractioncomplete", [1, 7, 8], TC_ACCEPT), false);

    expect(machine.snapshot()).toEqual({ analytics: "unknown", ads: "unknown" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("TCF"));
  });

  it("reports malformed TCData, and never throws it at the consent manager", () => {
    const { ladder } = harness();
    const cmp = new FakeCmp();
    const { boundary: b, reports } = boundary();
    watchTcf(cmp, b, ladder);

    expect(() => cmp.emit({ eventStatus: "tcloaded" })).not.toThrow();
    expect(reports).toEqual([{ stage: "consent", name: "ConsentError", message: "__tcfapi gave TCData without purpose.consents" }]);
  });

  it("emits events whose payload carries the TC string and validates against the schema", () => {
    const { machine, ladder, identified } = harness();
    const cmp = new FakeCmp();
    watchTcf(cmp, boundary().boundary, ladder);
    machine.collect(1);
    cmp.emit(tcData("useractioncomplete", [1, 8], TC_ACCEPT));

    const { event_id: eventId, ...input } = EVENT;
    const event = buildEvent({ ...input, consent: identified[0]! }, eventId);
    const validate = validator("event.json");

    expect(event.consent).toEqual({ analytics: "granted", ads: "denied", source: "tcf", tc_string: TC_ACCEPT });
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe("the machine's TC string", () => {
  it("refuses a TC string from a source other than tcf", () => {
    const { machine } = harness();
    expect(() => machine.update({ analytics: "granted" }, "manual", TC_ACCEPT)).toThrow(ConsentError);
    expect(machine.snapshot()).toEqual({ analytics: "unknown", ads: "unknown" });
  });
});
