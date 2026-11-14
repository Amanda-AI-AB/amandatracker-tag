// The consent sources that drive the state machine (consent.ts), and the ladder that picks one
// (02 §3, §5). The rungs, highest first:
//
//   gpc    -> the browser's Global Privacy Control (navigator.globalPrivacyControl), read once at
//             boot when the site honors it (consent.gpc_honored, on by default): it denies both
//             categories, and as the top rung nothing takes over from it for the rest of the page;
//   manual -> the site's own banner calls amanda('consent', {analytics, ads});
//   gcm    -> Google Consent Mode v2: gtag('consent', 'default' | 'update', {...}) entries in
//             window.dataLayer, those already there at boot and those pushed later;
//   tcf    -> an IAB TCF v2.2 consent manager: __tcfapi('addEventListener', 2, ...), whose
//             signals carry the TC string to the snapshot (AAI-160);
//   cookiebot -> a consent manager set up without Consent Mode or TCF, read through its own API
//             by an adapter the core loads only once it detects that consent manager
//             (watchCmpAdapters; Cookiebot, AAI-163);
//   onetrust -> the same, for OneTrust (AAI-164), below Cookiebot: a page has one or the other.
//
// The first source to give a definitive signal (a category granted or denied) wins, and the
// winner's later signals always apply. A higher rung takes over when it signals: once the site
// calls amanda('consent', ...), Consent Mode no longer moves the state. A lower rung never takes
// over from a winner. Each applied signal names its source in the snapshot every event carries.
//
// No source assumes a signal: a category it doesn't decide stays as it is, and nothing here
// defaults to granted (08 R11).

import type { AdapterConnect } from "./adapter-api";
import type { ErrorBoundary } from "./boundary";
import { warn } from "./boundary";
import { ConsentError, type Category, type ConsentSignal, type ConsentSource } from "./consent";
import type { Command } from "./queue";

/** What the ladder drives: the state machine's update (ConsentMachine). */
export interface ConsentInput {
  update(signal: ConsentSignal, source: ConsentSource, tcString?: string): void;
}

/** Each source's rung: the lower, the higher its priority. */
const RUNG: Readonly<Record<ConsentSource, number>> = { gpc: 0, manual: 1, gcm: 2, tcf: 3, cookiebot: 4, onetrust: 5 };

export interface ConsentLadder {
  /** The source whose signals drive the state now; undefined until one gave a definitive signal. */
  active(): ConsentSource | undefined;
  /**
   * Applies a source's signal if the ladder lets it through; true when it did. tcString is the TC
   * string a `tcf` signal came with, which the snapshot then carries.
   */
  signal(source: ConsentSource, signal: ConsentSignal, tcString?: string): boolean;
}

/** Whether signal decides a category: grants or denies it. */
export function isDefinitive(signal: ConsentSignal): boolean {
  return [signal.analytics, signal.ads].some((state) => state === "granted" || state === "denied");
}

export function createLadder(machine: ConsentInput): ConsentLadder {
  let active: ConsentSource | undefined;
  return {
    active: () => active,
    signal(source, signal, tcString) {
      if (!isDefinitive(signal)) return false;
      if (active !== undefined && source !== active && RUNG[source] > RUNG[active]) return false;
      machine.update(signal, source, tcString);
      active = source;
      return true;
    },
  };
}

// Global Privacy Control.
//
// GPC is a binding opt-out in California and Colorado, so a site honors it as a decline unless it
// turns that off. The tag reads the JavaScript property; the Sec-GPC request header carries the
// same signal, and the tag's own requests send it as the browser does. Legacy Do Not Track
// (navigator.doNotTrack, the DNT header) is deprecated and deliberately ignored: it neither
// denies nor grants anything.

/** The browser's navigator, as far as GPC goes. */
export interface GpcHost {
  readonly navigator: { readonly globalPrivacyControl?: unknown };
}

/** GPC's signal: both categories denied. */
export const GPC_SIGNAL: Readonly<ConsentSignal> = { analytics: "denied", ads: "denied" };

/** Whether the browser sends Global Privacy Control: only a literal true counts. */
export function gpcEnabled(win: GpcHost): boolean {
  return win.navigator.globalPrivacyControl === true;
}

/**
 * Honors Global Privacy Control: when the browser sends it, denies both categories as the ladder's
 * top rung, so no banner, Consent Mode or later signal grants anything on this page. Call it before
 * the other sources read anything. True when GPC was on.
 */
export function honorGpc(win: GpcHost, ladder: ConsentLadder): boolean {
  if (!gpcEnabled(win)) return false;
  ladder.signal("gpc", { ...GPC_SIGNAL });
  return true;
}

// The manual API.

const MANUAL_STATES = ["granted", "denied"];

/**
 * The site's amanda('consent', value) checked: an object of `analytics` and `ads`, each "granted"
 * or "denied", deciding at least one. Throws ConsentError for anything else: a banner can't send
 * unknown or no_cmp, and a misspelt signal must not pass for one.
 */
export function manualSignal(value: unknown): ConsentSignal {
  return checkedSignal(value, "amanda('consent', ...)");
}

/** value checked as manualSignal checks it; `caller` names who gave it in the errors. */
function checkedSignal(value: unknown, caller: string): ConsentSignal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConsentError(`${caller} takes an object: {analytics, ads}`);
  }
  const signal: ConsentSignal = {};
  for (const key of Object.keys(value)) {
    if (key !== "analytics" && key !== "ads") throw new ConsentError(`unknown consent category: ${key}`);
    const state = (value as Record<string, unknown>)[key];
    if (MANUAL_STATES.indexOf(state as string) < 0) {
      throw new ConsentError(`consent ${key} is granted or denied, not ${String(state)}`);
    }
    signal[key as Category] = state as "granted" | "denied";
  }
  if (!isDefinitive(signal)) throw new ConsentError(`${caller} decides neither analytics nor ads`);
  return signal;
}

/**
 * The `consent` command: amanda('consent', {analytics, ads}). The command queue guards it. Only
 * GPC outranks it; a call it overrules changes nothing, with a warning for the site's developers.
 */
export function consentCommand(ladder: ConsentLadder): Command {
  return (value: unknown) => {
    if (!ladder.signal("manual", manualSignal(value))) {
      warn("amanda: the browser sends Global Privacy Control, which this site honors; amanda('consent', ...) changes nothing");
    }
  };
}

// Google Consent Mode v2.

/** The page's window.dataLayer, which gtag() and Google Tag Manager push to. */
export interface ConsentModeHost {
  dataLayer?: unknown;
}

type GcmState = "granted" | "denied";

/** The Consent Mode types the tag reads: analytics from analytics_storage, ads from the other two. */
const GCM_TYPES = ["analytics_storage", "ad_storage", "ad_user_data"] as const;
type GcmType = (typeof GCM_TYPES)[number];

/**
 * Consent Mode's state as the dataLayer's consent commands build it. An `update` always sets the
 * types it names; a `default` sets only those no update has set yet. A default scoped to regions
 * is skipped: the tag doesn't know the visitor's region, and must not assume it is in one.
 */
export class ConsentModeState {
  private readonly state: Partial<Record<GcmType, GcmState>> = {};
  private readonly updated: Partial<Record<GcmType, true>> = {};

  /** Reads one dataLayer entry; true when it was a consent command the state took in. */
  read(entry: unknown): boolean {
    if (typeof entry !== "object" || entry === null) return false;
    const command = entry as ArrayLike<unknown>;
    if (typeof command.length !== "number" || command[0] !== "consent") return false;
    const kind = command[1];
    const params = command[2];
    if (kind !== "default" && kind !== "update") return false;
    if (typeof params !== "object" || params === null) {
      warn(`amanda: gtag('consent', '${kind}') without its parameters is ignored`);
      return false;
    }
    const values = params as Record<string, unknown>;
    if (kind === "default" && values.region !== undefined) return false;
    let read = false;
    for (const type of GCM_TYPES) {
      const value = values[type];
      if (value === undefined) continue;
      if (value !== "granted" && value !== "denied") {
        warn(`amanda: gtag('consent', '${kind}') sets ${type} to ${String(value)}, not granted or denied; ignored`);
        continue;
      }
      if (kind === "default" && this.updated[type]) continue;
      this.state[type] = value;
      if (kind === "update") this.updated[type] = true;
      read = true;
    }
    return read;
  }

  /**
   * The signal the state gives: analytics is analytics_storage; ads is denied when ad_storage or
   * ad_user_data is, and granted only when both are, since Consent Mode v2 needs both to use data
   * for ads. A category Consent Mode hasn't decided is left out.
   */
  signal(): ConsentSignal {
    const signal: ConsentSignal = {};
    const { analytics_storage: analytics, ad_storage: storage, ad_user_data: userData } = this.state;
    if (analytics) signal.analytics = analytics;
    if (storage === "denied" || userData === "denied") signal.ads = "denied";
    else if (storage === "granted" && userData === "granted") signal.ads = "granted";
    return signal;
  }
}

/**
 * Follows Google Consent Mode on win: reads the consent commands already in window.dataLayer, as
 * one signal, then each later push to it. Defines window.dataLayer as gtag's snippet does when the
 * page has none yet, so a gtag loaded later pushes to the array the tag watches. Each push is
 * handed to the page's push first, and its consent commands are read inside the boundary: a
 * failure there is reported and never reaches whoever pushed. Throws ConsentError when
 * window.dataLayer is not an array.
 */
export function watchConsentMode(win: ConsentModeHost, boundary: ErrorBoundary, ladder: ConsentLadder): void {
  if (win.dataLayer === undefined) win.dataLayer = [];
  const layer = win.dataLayer;
  if (!Array.isArray(layer)) throw new ConsentError("window.dataLayer is not an array; Consent Mode is not followed");
  const gcm = new ConsentModeState();
  const readAll = (entries: ArrayLike<unknown>): void => {
    let read = false;
    for (let i = 0; i < entries.length; i++) read = gcm.read(entries[i]) || read;
    if (read) ladder.signal("gcm", gcm.signal());
  };
  readAll(layer.slice());
  const push = layer.push;
  layer.push = function (this: unknown, ...items: unknown[]): number {
    const length = push.apply(this as unknown[], items);
    boundary.guard("consent", () => readAll(items));
    return length;
  };
}

// IAB TCF v2.2.
//
// The purpose mapping is the proposed one (AAI-160), built ahead of counsel's sign-off, which gates
// production, not building: analytics needs the consent to Purpose 1 (store and access information
// on a device) and Purpose 8 (measure content performance); ads, Purpose 1 and Purpose 7 (measure
// advertising performance). A category is granted when its purposes all are, and denied otherwise.

/** The page's TCF API, as the consent manager's stub defines it. */
export interface TcfHost {
  __tcfapi?: unknown;
}

/** The TCF purposes each category needs consent to. */
export const TCF_PURPOSES: Readonly<Record<Category, readonly number[]>> = { analytics: [1, 8], ads: [1, 7] };

/** A TCF signal: the categories it decides, and the TC string it came with, when one did. */
export interface TcfSignal {
  readonly signal: ConsentSignal;
  readonly tcString?: string;
}

/**
 * The signal one TCData gives, as __tcfapi's addEventListener hands it over; undefined when it
 * gives none: while the consent manager's UI is up (cmpuishown, the visitor is still deciding), or
 * when GDPR doesn't apply, where TCF decides nothing and the tag must not assume it granted
 * anything. Throws ConsentError on TCData that is not TCF v2's.
 */
export function tcfSignal(tcData: unknown): TcfSignal | undefined {
  if (typeof tcData !== "object" || tcData === null) throw new ConsentError("__tcfapi gave TCData that is not an object");
  const data = tcData as Record<string, unknown>;
  const status = data.eventStatus;
  if (status === "cmpuishown") return undefined;
  if (status !== "tcloaded" && status !== "useractioncomplete") {
    throw new ConsentError(`__tcfapi gave an unknown eventStatus: ${String(status)}`);
  }
  if (data.gdprApplies === false) return undefined;
  const purpose = data.purpose as { consents?: unknown } | undefined;
  const consents = typeof purpose === "object" && purpose !== null ? purpose.consents : undefined;
  if (typeof consents !== "object" || consents === null) {
    throw new ConsentError("__tcfapi gave TCData without purpose.consents");
  }
  const granted = (id: number): boolean => (consents as Record<string, unknown>)[id] === true;
  const signal: ConsentSignal = {};
  for (const category of ["analytics", "ads"] as const) {
    signal[category] = TCF_PURPOSES[category].every(granted) ? "granted" : "denied";
  }
  const tcString = data.tcString;
  return typeof tcString === "string" && tcString !== "" ? { signal, tcString } : { signal };
}

/**
 * Follows the page's TCF v2.2 consent manager: registers with __tcfapi('addEventListener', 2, ...),
 * which calls back with the current consent and again on each change. Each callback runs inside
 * the boundary, so a failure there is reported and never reaches the consent manager. False when
 * the page has no __tcfapi, true when the tag listens.
 */
export function watchTcf(win: TcfHost, boundary: ErrorBoundary, ladder: ConsentLadder): boolean {
  const api = win.__tcfapi;
  if (typeof api !== "function") return false;
  api("addEventListener", 2, (tcData: unknown, success: unknown) => {
    boundary.guard("consent", () => {
      if (success !== true) {
        warn("amanda: the TCF consent manager reported a failure; its consent is not followed");
        return;
      }
      const tcf = tcfSignal(tcData);
      if (tcf) ladder.signal("tcf", tcf.signal, tcf.tcString);
    });
  });
  return true;
}

// Consent-manager adapters.
//
// A consent manager set up without Consent Mode or TCF is read through its own API, by an adapter
// built to its own file (src/adapters/<name>.ts, scripts/build.mjs), so it costs the core nothing on
// the sites that don't use it. The core loads one only once it detects its consent manager: the
// global that manager defines is there at boot, or one of the window events it fires on loading
// comes later. The adapter then connects through amanda('adapter', name, connect)
// (adapter-api.ts), and its signals drive the ladder as its own source, below TCF.

/** The page's window, as far as detecting consent managers goes. */
export interface CmpHost {
  addEventListener(type: string, listener: () => void): void;
}

/** A consent manager the tag has an adapter for. */
export interface CmpAdapter {
  /** The adapter's name, its file's (adapters/<version>/<name>.js), and the consent source it signals as. */
  readonly name: ConsentSource;
  /** The window property the consent manager defines once its script runs. */
  readonly global: string;
  /** The window events the consent manager fires as it loads or decides, for one loaded after the tag. */
  readonly events: readonly string[];
}

export const CMP_ADAPTERS: readonly CmpAdapter[] = [
  { name: "cookiebot", global: "Cookiebot", events: ["CookiebotOnLoad", "CookiebotOnConsentReady"] },
  { name: "onetrust", global: "OneTrust", events: ["OneTrustGroupsUpdated"] },
];

/**
 * Loads the adapter of each consent manager in `adapters` the page has, with `load`, at once when
 * the manager's global is there and else on the first of its events; at most once per adapter, and
 * never for a manager the page doesn't have. A load that fails is reported. Returns the `adapter`
 * command, through which a loaded adapter connects, once: it throws ConsentError for an adapter
 * that wasn't loaded or has connected already, so a page can't open a second channel for one.
 */
export function watchCmpAdapters(
  win: CmpHost,
  boundary: ErrorBoundary,
  ladder: ConsentLadder,
  load: (name: string) => Promise<void>,
  adapters: readonly CmpAdapter[] = CMP_ADAPTERS,
): Command {
  /** Adapter name -> true while it is loaded and not yet connected. */
  const awaited: { [name: string]: boolean } = {};
  for (const adapter of adapters) {
    let detected = false;
    const detect = (): void => {
      boundary.guard("consent", () => {
        if (detected) return;
        detected = true;
        awaited[adapter.name] = true;
        boundary.watch("consent", load(adapter.name));
      });
    };
    if ((win as unknown as Record<string, unknown>)[adapter.global] !== undefined) detect();
    else for (const type of adapter.events) win.addEventListener(type, detect);
  }
  return (name: unknown, connect: unknown) => {
    if (typeof name !== "string" || awaited[name] !== true) {
      throw new ConsentError(`amanda('adapter', ...): no adapter ${String(name)} awaits connecting`);
    }
    if (typeof connect !== "function") throw new ConsentError(`amanda('adapter', ...): adapter ${name} gave no function`);
    awaited[name] = false;
    const source = name as ConsentSource;
    const caller = `the ${name} adapter's signal`;
    boundary.guard("consent", () =>
      (connect as AdapterConnect)({
        signal: (signal) => {
          ladder.signal(source, checkedSignal(signal, caller));
        },
        guard: (fn) => {
          boundary.guard("consent", fn);
        },
      }),
    );
  };
}
