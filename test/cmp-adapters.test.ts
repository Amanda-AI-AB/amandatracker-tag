import { afterEach, describe, expect, it, vi } from "vitest";
import { connectAdapter, type AdapterApi, type AdapterConnect } from "../src/core/adapter-api";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import { createConsent } from "../src/core/consent";
import { CMP_ADAPTERS, createLadder, watchCmpAdapters, type CmpHost } from "../src/core/consent-sources";

function setup(globals: Record<string, unknown> = {}, load: (name: string) => Promise<void> = async () => undefined) {
  const listeners: Record<string, (() => void)[]> = {};
  const win = {
    ...globals,
    addEventListener: (type: string, listener: () => void) => (listeners[type] = listeners[type] || []).push(listener),
  } as CmpHost;
  const reports: ErrorReport[] = [];
  const boundary = new ErrorBoundary((report) => reports.push(report), 1);
  const machine = createConsent<number>({
    declinedMode: "off",
    sink: { identified: () => undefined, anonymous: () => undefined, withdraw: () => undefined },
    identity: { forget: () => undefined, renew: () => undefined },
  });
  const ladder = createLadder(machine);
  const loadMock = vi.fn(load);
  const command = watchCmpAdapters(win, boundary, ladder, loadMock);
  const fire = (type: string): void => (listeners[type] || []).forEach((listener) => listener());
  /** Connects as an adapter does, and returns the api the core gave it. */
  const connect = (name: string): AdapterApi => {
    let api: AdapterApi | undefined;
    command(name, (given: AdapterApi) => (api = given));
    return api!;
  };
  return { machine, ladder, reports, load: loadMock, command, fire, connect };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CMP_ADAPTERS", () => {
  it("has Cookiebot, OneTrust and Usercentrics, each detected by its global or the events it fires", () => {
    expect(CMP_ADAPTERS).toEqual([
      { name: "cookiebot", global: "Cookiebot", events: ["CookiebotOnLoad", "CookiebotOnConsentReady"] },
      { name: "onetrust", global: "OneTrust", events: ["OneTrustGroupsUpdated"] },
      { name: "usercentrics", global: "UC_UI", events: ["UC_UI_INITIALIZED"] },
    ]);
  });
});

describe("watchCmpAdapters", () => {
  it("loads nothing on a page without the consent manager", () => {
    const { load } = setup();
    expect(load).not.toHaveBeenCalled();
  });

  it("loads the adapter at once when the consent manager's global is there", () => {
    const { load } = setup({ Cookiebot: {} });
    expect(load.mock.calls).toEqual([["cookiebot"]]);
  });

  it("loads the adapter of a consent manager loaded after the tag, on its first event, once", () => {
    const { load, fire } = setup();
    fire("CookiebotOnLoad");
    fire("CookiebotOnConsentReady");
    fire("CookiebotOnLoad");
    expect(load.mock.calls).toEqual([["cookiebot"]]);
  });

  it("reports an adapter that failed to load", async () => {
    const { reports } = setup({ Cookiebot: {} }, async () => {
      throw new Error("failed to load adapter cookiebot");
    });
    await flush();
    expect(reports).toEqual([{ stage: "consent", name: "Error", message: "failed to load adapter cookiebot" }]);
  });

  it("drives the ladder with a connected adapter's signals, as its own source", () => {
    const { machine, connect } = setup({ Cookiebot: {} });
    const api = connect("cookiebot");

    api.signal({ analytics: "denied", ads: "denied" });
    expect(machine.snapshot()).toEqual({ analytics: "denied", ads: "denied", source: "cookiebot" });
    api.signal({ analytics: "granted", ads: "granted" });
    expect(machine.snapshot()).toEqual({ analytics: "granted", ads: "granted", source: "cookiebot" });
  });

  it("ranks the adapter below TCF and the other sources, which take over from it, and never the reverse", () => {
    const { machine, ladder, connect } = setup({ Cookiebot: {} });
    const api = connect("cookiebot");
    api.signal({ analytics: "granted", ads: "granted" });

    ladder.signal("tcf", { analytics: "denied", ads: "denied" });
    api.signal({ analytics: "granted", ads: "granted" });
    expect(machine.snapshot()).toEqual({ analytics: "denied", ads: "denied", source: "tcf" });
    expect(ladder.active()).toBe("tcf");
  });

  it("refuses an adapter's signal that isn't granted or denied, changing nothing", () => {
    const { machine, connect } = setup({ Cookiebot: {} });
    const api = connect("cookiebot");
    expect(() => api.signal({})).toThrow("the cookiebot adapter's signal decides neither analytics nor ads");
    expect(() => api.signal({ analytics: "unknown" })).toThrow("consent analytics is granted or denied, not unknown");
    expect(() => api.signal({ analytics: "no_cmp" })).toThrow("consent analytics is granted or denied, not no_cmp");
    expect(machine.snapshot()).toEqual({ analytics: "unknown", ads: "unknown" });
  });

  it("guards what the adapter runs in its api, reporting it at the consent stage", () => {
    const { reports, connect } = setup({ Cookiebot: {} });
    const api = connect("cookiebot");
    expect(() =>
      api.guard(() => {
        throw new TypeError("boom");
      }),
    ).not.toThrow();
    expect(reports).toEqual([{ stage: "consent", name: "TypeError", message: "boom" }]);
  });

  it("guards the adapter's connect, reporting what it throws at the consent stage", () => {
    const { reports, command } = setup({ Cookiebot: {} });
    command("cookiebot", () => {
      throw new TypeError("boom");
    });
    expect(reports).toEqual([{ stage: "consent", name: "TypeError", message: "boom" }]);
  });

  it("connects only an adapter it loaded, and only once", () => {
    const { command, connect } = setup({ Cookiebot: {} });
    connect("cookiebot");
    expect(() => command("cookiebot", () => undefined)).toThrow("no adapter cookiebot awaits connecting");
    expect(() => command("example-cmp", () => undefined)).toThrow("no adapter example-cmp awaits connecting");
    expect(() => command("constructor", () => undefined)).toThrow("no adapter constructor awaits connecting");
  });

  it("refuses to connect an adapter not loaded yet, and one that gives no function", () => {
    const { command, fire } = setup();
    expect(() => command("cookiebot", () => undefined)).toThrow("no adapter cookiebot awaits connecting");
    fire("CookiebotOnLoad");
    expect(() => command("cookiebot", "not a function")).toThrow("adapter cookiebot gave no function");
  });
});

describe("connectAdapter", () => {
  it("connects through amanda('adapter', name, connect)", () => {
    const amanda = vi.fn();
    const connect: AdapterConnect = () => undefined;
    connectAdapter({ amanda }, "cookiebot", connect);
    expect(amanda.mock.calls).toEqual([["adapter", "cookiebot", connect]]);
  });

  it("warns, and connects nothing, on a page without the tag", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    connectAdapter({}, "cookiebot", () => undefined);
    expect(warn).toHaveBeenCalledWith("amanda: the cookiebot adapter loaded without the tag; it follows nothing");
  });
});
