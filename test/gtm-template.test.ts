// The local harness of the Google Tag Manager template (template.tpl, AAI-154). GTM itself needs a
// Google login, so a person runs the template's ___TESTS___ and Preview in a test container; this
// runs its sandboxed code here, with stand-ins for GTM's APIs, against the tag's real command
// queue and its real consent, event and purchase commands, and checks that its permissions manifest
// asks for nothing beyond the list the ticket allows.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import type { ConsentSignal, ConsentSource } from "../src/core/consent";
import { consentCommand, createLadder } from "../src/core/consent-sources";
import { eventCommand, type CustomEvent } from "../src/core/custom-event";
import { purchaseCommand } from "../src/core/purchase";
import { installCommands, type AmandaFunction } from "../src/core/queue";
import type { Purchase } from "../src/wire/generated";

const TEMPLATE = readFileSync(join(__dirname, "..", "template.tpl"), "utf8");

/** The template's ___<NAME>___ sections, by name. */
function sections(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  const parts = text.split(/^___([A-Z_]+)___$/m);
  for (let i = 1; i < parts.length; i += 2) found[parts[i]!] = parts[i + 1]!.trim();
  return found;
}

const SECTIONS = sections(TEMPLATE);
const CODE = SECTIONS.SANDBOXED_JS_FOR_WEB_TEMPLATE!;

/** The GTM APIs the code requires, each with the permission it needs, or null for none. */
const API_PERMISSIONS: Record<string, string | null> = {
  addConsentListener: "access_consent",
  isConsentGranted: "access_consent",
  callInWindow: "access_globals",
  createArgumentsQueue: "access_globals",
  injectScript: "inject_script",
  logToConsole: "logging",
  encodeUriComponent: null,
  getType: null,
  makeNumber: null,
  makeString: null,
  makeTableMap: null,
};

/** What the ticket allows, with access_globals added by the answer of 2026-11-14. */
const ALLOWED = ["inject_script", "get_cookies", "set_cookies", "access_consent", "read_data_layer", "logging", "access_globals"];

interface Param {
  type: number;
  string?: string;
  boolean?: boolean;
  listItem?: Param[];
  mapKey?: Param[];
  mapValue?: Param[];
}
interface Permission {
  instance: { key: { publicId: string }; param?: { key: string; value: Param }[] };
}

/** A permission's param as plain values: strings, booleans, lists and maps. */
function plain(param: Param): unknown {
  if (param.type === 1) return param.string;
  if (param.type === 8) return param.boolean;
  if (param.type === 2) return param.listItem!.map(plain);
  if (param.type === 3) {
    const map: Record<string, unknown> = {};
    param.mapKey!.forEach((key, i) => (map[key.string!] = plain(param.mapValue![i]!)));
    return map;
  }
  throw new Error(`unexpected param type ${param.type}`);
}

const PERMISSIONS = new Map(
  (JSON.parse(SECTIONS.WEB_PERMISSIONS!) as Permission[]).map((p) => [
    p.instance.key.publicId,
    Object.fromEntries((p.instance.param ?? []).map((param) => [param.key, plain(param.value)])),
  ]),
);

describe("the template's permissions manifest", () => {
  it("asks only for permissions on the ticket's list", () => {
    for (const id of PERMISSIONS.keys()) expect(ALLOWED).toContain(id);
  });

  it("asks for exactly the permissions the code's APIs need", () => {
    const required = [...CODE.matchAll(/require\('([A-Za-z]+)'\)/g)].map((m) => m[1]!);
    for (const api of required) expect(Object.keys(API_PERMISSIONS), `an API the harness doesn't know: ${api}`).toContain(api);
    const needed = new Set(required.map((api) => API_PERMISSIONS[api]).filter((p): p is string => p !== null));
    expect([...PERMISSIONS.keys()].sort()).toEqual([...needed].sort());
  });

  it("injects only a.js, from the collection host", () => {
    expect(PERMISSIONS.get("inject_script")).toEqual({ urls: ["https://eu.serversider.com/a.js*"] });
  });

  it("reaches only window.amanda and its queue, and executes only amanda", () => {
    expect(PERMISSIONS.get("access_globals")).toEqual({
      keys: [
        { key: "amanda", read: true, write: true, execute: true },
        { key: "amanda.q", read: true, write: true, execute: false },
      ],
    });
  });

  it("reads the three consent types the tag follows, and writes none", () => {
    expect(PERMISSIONS.get("access_consent")).toEqual({
      consentTypes: ["analytics_storage", "ad_storage", "ad_user_data"].map((consentType) => ({ consentType, read: true, write: false })),
    });
  });

  it("logs in debug mode only", () => {
    expect(PERMISSIONS.get("logging")).toEqual({ environments: "debug" });
  });

  it("declares its parameters and info as JSON, with the Site ID required", () => {
    const info = JSON.parse(SECTIONS.INFO!);
    expect(info).toMatchObject({ type: "TAG", containerContexts: ["WEB"] });
    const params = JSON.parse(SECTIONS.TEMPLATE_PARAMETERS!) as { name: string; valueValidators?: { type: string }[] }[];
    expect(params[0]).toMatchObject({ name: "siteId", valueValidators: [{ type: "NON_EMPTY" }, { type: "REGEX" }] });
  });
});

/** A page with GTM's APIs stood in for, on which the template runs and a.js "loads". */
class Page {
  readonly window: { amanda?: AmandaFunction } = {};
  readonly injected: { url: string; cacheToken: string }[] = [];
  readonly consentState: Record<string, boolean | undefined> = {};
  readonly listeners: Record<string, (type: string, granted: boolean) => void> = {};
  readonly logs: string[] = [];
  /** What the tag's commands received, and what its boundary reported. */
  readonly consent: { signal: ConsentSignal; source: ConsentSource }[] = [];
  readonly events: CustomEvent[] = [];
  readonly purchases: Purchase[] = [];
  readonly reports: ErrorReport[] = [];
  succeeded = 0;
  failed = 0;
  /** Whether injectScript's script loads; when it does, the tag installs its commands. */
  loads = true;
  consentRead = false;

  private readonly boundary = new ErrorBoundary((report) => this.reports.push(report), 1);

  /** GTM's APIs, as far as the template uses them. */
  private api(): Record<string, unknown> {
    const win = this.window;
    return {
      addConsentListener: (type: string, listener: (type: string, granted: boolean) => void) => {
        this.listeners[type] = listener;
      },
      isConsentGranted: (type: string) => {
        this.consentRead = true;
        // GTM's own rule: a type with no state counts as granted.
        return this.consentState[type] !== false;
      },
      callInWindow: (name: string, ...args: unknown[]) => {
        const fn = (win as Record<string, unknown>)[name];
        if (typeof fn !== "function") throw new Error(`window.${name} is not a function`);
        return fn(...args);
      },
      // GTM's createArgumentsQueue: leaves a function already there, else defines the snippet's stub.
      createArgumentsQueue: (fnKey: string, arrayKey: string) => {
        expect([fnKey, arrayKey]).toEqual(["amanda", "amanda.q"]);
        if (typeof win.amanda !== "function") {
          const stub: AmandaFunction = function (...args: unknown[]) {
            (stub.q = stub.q || []).push(args);
          };
          win.amanda = stub;
        }
        return win.amanda;
      },
      injectScript: (url: string, onSuccess: () => void, onFailure: () => void, cacheToken: string) => {
        this.injected.push({ url, cacheToken });
        if (!this.loads) return onFailure();
        // The script runs once; a later injection with the same cacheToken only reports success.
        if (this.window.amanda?.loaded !== true) this.loadTag();
        onSuccess();
      },
      logToConsole: (...args: unknown[]) => {
        this.logs.push(args.join(" "));
      },
      encodeUriComponent: encodeURIComponent,
      getType: (value: unknown) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value),
      makeNumber: (value: unknown) => Number(value),
      makeString: (value: unknown) => String(value),
      makeTableMap: (rows: Record<string, unknown>[], key: string, value: string) =>
        Object.fromEntries(rows.map((row) => [row[key], row[value]])),
    };
  }

  /** What a.js does once it has booted: installs the commands and runs what the stub queued. */
  private loadTag(): void {
    const ladder = createLadder({ update: (signal, source) => this.consent.push({ signal, source }) });
    installCommands(
      this.window,
      {
        consent: consentCommand(ladder),
        event: eventCommand((event) => this.events.push(event)),
        purchase: purchaseCommand((purchase) => this.purchases.push(purchase)),
      },
      this.boundary,
    );
  }

  /** Fires the template as a tag with `data`, the fields GTM resolved. */
  fire(data: Record<string, unknown>): void {
    const api = this.api();
    const run = new Function("require", "data", CODE) as (require: (name: string) => unknown, data: unknown) => void;
    run(
      (name) => {
        if (!(name in api)) throw new Error(`require('${name}') has no stand-in`);
        return api[name];
      },
      { ...data, gtmOnSuccess: () => this.succeeded++, gtmOnFailure: () => this.failed++ },
    );
  }
}

const INIT = { siteId: "site_123", eventType: "init", consentBridge: true };

describe("the template", () => {
  it("loads a.js once, with the Site ID in its query, and succeeds", () => {
    const page = new Page();
    page.fire(INIT);

    expect(page.injected).toEqual([{ url: "https://eu.serversider.com/a.js?site=site_123", cacheToken: "amanda" }]);
    expect(page.window.amanda!.loaded).toBe(true);
    expect([page.succeeded, page.failed]).toEqual([1, 0]);
  });

  it("puts the endpoint override in the query, encoded", () => {
    const page = new Page();
    page.fire({ ...INIT, endpoint: "/amnda" });

    expect(page.injected[0]!.url).toBe("https://eu.serversider.com/a.js?site=site_123&endpoint=%2Famnda");
    expect(new URL(page.injected[0]!.url).searchParams.get("endpoint")).toBe("/amnda");
  });

  describe("bridges GTM's consent into amanda('consent', ...)", () => {
    it("forwards a denial at once, which the tag takes as the manual source's", () => {
      const page = new Page();
      Object.assign(page.consentState, { analytics_storage: false, ad_storage: true, ad_user_data: false });
      page.fire(INIT);

      expect(page.consent).toEqual([{ signal: { analytics: "denied", ads: "denied" }, source: "manual" }]);
      expect(page.reports).toEqual([]);
    });

    it("never forwards granted-or-unset as a grant", () => {
      const page = new Page();
      page.fire(INIT);

      expect(page.consentRead).toBe(true);
      expect(page.consent).toEqual([]);
      expect(Object.keys(page.listeners).sort()).toEqual(["ad_storage", "ad_user_data", "analytics_storage"]);
    });

    it("forwards each change GTM reports, after the tag has loaded too", () => {
      const page = new Page();
      Object.assign(page.consentState, { analytics_storage: false, ad_storage: false, ad_user_data: false });
      page.fire(INIT);
      page.listeners.analytics_storage!("analytics_storage", true);
      page.listeners.ad_storage!("ad_storage", true);
      page.listeners.ad_user_data!("ad_user_data", true);
      page.listeners.analytics_storage!("analytics_storage", false);

      expect(page.consent.map((c) => c.signal)).toEqual([
        { analytics: "denied", ads: "denied" },
        { analytics: "granted", ads: "denied" },
        { analytics: "granted", ads: "denied" },
        { analytics: "granted", ads: "granted" },
        { analytics: "denied", ads: "granted" },
      ]);
      expect(page.consent.every((c) => c.source === "manual")).toBe(true);
      expect(page.reports).toEqual([]);
    });

    it("grants ads only once both ad_storage and ad_user_data are known granted", () => {
      const page = new Page();
      Object.assign(page.consentState, { ad_storage: false });
      page.fire(INIT);
      page.listeners.ad_storage!("ad_storage", true);

      // ad_user_data has no known state: ads isn't decided, and nothing is forwarded for it.
      expect(page.consent.map((c) => c.signal)).toEqual([{ ads: "denied" }]);
    });

    it("leaves consent alone when the bridge is off", () => {
      const page = new Page();
      Object.assign(page.consentState, { analytics_storage: false });
      page.fire({ ...INIT, consentBridge: false });

      expect(page.consentRead).toBe(false);
      expect(page.listeners).toEqual({});
      expect(page.consent).toEqual([]);
      expect(page.succeeded).toBe(1);
    });
  });

  it("sends a custom event with its properties, through the tag's event command", () => {
    const page = new Page();
    page.fire({ siteId: "site_123", eventType: "event", eventName: "signup", eventProps: [{ key: "plan", value: "pro" }, { key: "seats", value: 3 }] });

    expect(page.events).toEqual([{ name: "signup", props: { plan: "pro", seats: 3 } }]);
    expect(page.consentRead).toBe(false);
    expect(page.reports).toEqual([]);
    expect(page.succeeded).toBe(1);
  });

  it("sends a custom event without properties", () => {
    const page = new Page();
    page.fire({ siteId: "site_123", eventType: "event", eventName: "signup", eventProps: [] });

    expect(page.events).toEqual([{ name: "signup" }]);
  });

  it("sends a purchase, reading GA4's items as the tag's", () => {
    const page = new Page();
    page.fire({
      siteId: "site_123",
      eventType: "purchase",
      orderId: 1001,
      revenue: "249.9",
      currency: "SEK",
      items: [
        { item_id: "TSH-RED-M", item_name: "T-shirt, red, M", quantity: 2, price: 124.95 },
        { sku: "CAP", qty: 1, price: 0 },
      ],
    });

    expect(page.purchases).toEqual([
      {
        order_id: "1001",
        revenue: 249.9,
        currency: "SEK",
        items: [
          { sku: "TSH-RED-M", name: "T-shirt, red, M", qty: 2, price: 124.95 },
          { sku: "CAP", qty: 1, price: 0 },
        ],
      },
    ]);
    expect(page.reports).toEqual([]);
  });

  it("fails a purchase whose revenue or items it can't read, and loads nothing", () => {
    for (const fields of [{ revenue: "n/a" }, { revenue: "10", items: "TSH-RED-M" }]) {
      const page = new Page();
      page.fire({ siteId: "site_123", eventType: "purchase", orderId: "1001", currency: "SEK", ...fields });

      expect(page.failed).toBe(1);
      expect(page.injected).toEqual([]);
      expect(page.purchases).toEqual([]);
      expect(page.logs[0]).toMatch(/^Amanda Tracker: /);
    }
  });

  it("queues calls made before a.js loads, and the tag runs them in order once it has", () => {
    const page = new Page();
    page.loads = false;
    Object.assign(page.consentState, { analytics_storage: false });
    page.fire(INIT);
    page.fire({ siteId: "site_123", eventType: "event", eventName: "signup" });
    expect(page.failed).toBe(2);
    expect(page.window.amanda!.q).toHaveLength(2);

    page.loads = true;
    page.fire({ siteId: "site_123", eventType: "event", eventName: "second" });

    expect(page.consent.map((c) => c.signal)).toEqual([{ analytics: "denied" }]);
    expect(page.events.map((e) => e.name)).toEqual(["signup", "second"]);
  });

  it("refuses, through the tag's boundary, what the tag's commands refuse", () => {
    const page = new Page();
    page.fire({ siteId: "site_123", eventType: "event", eventName: "pageview" });

    expect(page.events).toEqual([]);
    expect(page.reports).toEqual([{ stage: "command", name: "CommandError", message: expect.stringContaining("pageview") }]);
  });
});
