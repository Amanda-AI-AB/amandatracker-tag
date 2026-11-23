// Usercentrics, for sites whose Usercentrics is set up without Consent Mode or TCF (02 §3.4): the
// usercentrics adapter (src/adapters/usercentrics.ts) follows either of its two web CMPs.
//
// - v2, the Browser UI: window.UC_UI. The adapter reads it once it connects, and again on each
//   UC_UI_INITIALIZED, which Usercentrics fires once it is ready, and each UC_UI_CMP_EVENT, which
//   it fires on the visitor's choices in its banner: accept, reject and change.
// - v3, the CMP of web.cmp.usercentrics.eu/ui/loader.js: window.__ucCmp, whose methods all return
//   promises (https://usercentrics.com/docs/web/features/api/control-functionality/). The adapter
//   reads __ucCmp.getConsentDetails() once it connects and on each UC_UI_INITIALIZED, as soon as
//   __ucCmp.isInitialized() resolves true, and takes each UC_CONSENT's detail, the same
//   ConsentDetails, which v3 dispatches every time it applies a consent state
//   (https://usercentrics.com/docs/web/features/events/uc-consent/). A read that resolves after a
//   newer one is dropped, so a slow promise never undoes the visitor's latest choice.
//
// A page with __ucCmp is followed as v3 alone, whatever else it defines. A read that repeats the
// last one changes nothing.
//
// Usercentrics keeps consent per service, each in a category: analytics is its default Functional
// category (slug `functional`, "to analyse the use of the website"), and ads its Marketing one
// (`marketing`). A category is granted only when it has services and the visitor explicitly
// consented to every one of them (v2: each service's latest consent history entry is `explicit`,
// its status true; v3: each service's consent is `EXPLICIT`, given true); anything less is
// denied. A visitor who hasn't answered the banner yet (v2: UC_UI.isConsentRequired() is not
// false; v3: consent.required is true) has decided nothing, whatever the services' defaults say
// meanwhile: the signal is none, and the state stays unknown, never assumed granted or denied
// (08 R11).

import type { AdapterApi } from "../core/adapter-api";
import { ConsentError, type Category, type ConsentSignal } from "../core/consent";
import { isRecord } from "../core/guards";

/** The page's window, as far as Usercentrics goes. */
export interface UsercentricsHost {
  UC_UI?: unknown;
  __ucCmp?: unknown;
  addEventListener(type: string, listener: (event?: unknown) => void): void;
}

/** The Usercentrics category (its slug) each consent category reads. */
export const USERCENTRICS_CATEGORIES: Readonly<Record<Category, string>> = { analytics: "functional", ads: "marketing" };

/** The window events after which the adapter reads Usercentrics again. */
export const USERCENTRICS_EVENTS: readonly string[] = ["UC_UI_INITIALIZED", "UC_UI_CMP_EVENT"];

/** The window event whose detail carries v3's ConsentDetails. */
export const USERCENTRICS_CONSENT_EVENT = "UC_CONSENT";

/** Calls api's method `name`, throwing ConsentError when it has none; `owner` names api in the error. */
function call(api: Record<string, unknown>, owner: string, name: string): unknown {
  const method = api[name];
  if (typeof method !== "function") throw new ConsentError(`${owner}.${name} is not a function`);
  return (method as () => unknown).call(api);
}

/** Per category slug: its services, and how many of them the visitor explicitly consented to. */
type Counts = { [slug: string]: { services: number; granted: number } };

function count(counts: Counts, slug: string, granted: boolean): void {
  const entry = (counts[slug] = counts[slug] || { services: 0, granted: 0 });
  entry.services++;
  if (granted) entry.granted++;
}

/** The signal counts give: a category is granted when it has services and all are, else denied. */
function signalOf(counts: Counts): ConsentSignal {
  const signal: ConsentSignal = {};
  for (const category of ["analytics", "ads"] as const) {
    const entry = counts[USERCENTRICS_CATEGORIES[category]];
    signal[category] = entry !== undefined && entry.granted === entry.services ? "granted" : "denied";
  }
  return signal;
}

// v2, the Browser UI.

/** Whether the visitor explicitly consented to service, one of getServicesBaseInfo()'s entries. */
function explicitlyGranted(service: unknown, index: number): boolean {
  const where = `window.UC_UI.getServicesBaseInfo()[${index}]`;
  const consent = isRecord(service) ? service.consent : undefined;
  if (!isRecord(consent)) throw new ConsentError(`${where} has no consent`);
  const { status, history } = consent;
  if (typeof status !== "boolean") throw new ConsentError(`${where}.consent.status is not a boolean: ${String(status)}`);
  if (!Array.isArray(history)) throw new ConsentError(`${where}.consent.history is not an array`);
  const latest: unknown = history[history.length - 1];
  return status && isRecord(latest) && latest.type === "explicit";
}

/**
 * The signal window.UC_UI gives; undefined while the visitor hasn't answered. Throws ConsentError
 * on a UC_UI that isn't an object or lacks isConsentRequired() or getServicesBaseInfo(), or whose
 * services aren't a list of entries, each with a category slug and a consent status and history.
 */
export function usercentricsSignal(ui: unknown): ConsentSignal | undefined {
  if (!isRecord(ui)) throw new ConsentError("window.UC_UI is not an object");
  if (call(ui, "window.UC_UI", "isConsentRequired") !== false) return undefined;
  const services = call(ui, "window.UC_UI", "getServicesBaseInfo");
  if (!Array.isArray(services)) throw new ConsentError("window.UC_UI.getServicesBaseInfo() is not an array");
  const counts: Counts = {};
  services.forEach((service: unknown, index) => {
    const slug = isRecord(service) ? service.categorySlug : undefined;
    if (typeof slug !== "string") {
      throw new ConsentError(`window.UC_UI.getServicesBaseInfo()[${index}].categorySlug is not a string: ${String(slug)}`);
    }
    count(counts, slug, explicitlyGranted(service, index));
  });
  return signalOf(counts);
}

// v3, the CMP.

/** Whether the visitor explicitly consented to service, one of ConsentDetails' services at `where`. */
function explicitlyGivenV3(service: Record<string, unknown>, where: string): boolean {
  const consent = service.consent;
  // ServiceData.consent is optional: a service without one has had no consent given.
  if (consent === undefined) return false;
  if (!isRecord(consent)) throw new ConsentError(`${where}.consent is not an object`);
  const { given, type } = consent;
  if (typeof given !== "boolean") throw new ConsentError(`${where}.consent.given is not a boolean: ${String(given)}`);
  if (type !== "EXPLICIT" && type !== "IMPLICIT") {
    throw new ConsentError(`${where}.consent.type is not EXPLICIT or IMPLICIT: ${String(type)}`);
  }
  return given && type === "EXPLICIT";
}

/**
 * The signal one v3 ConsentDetails gives, as __ucCmp.getConsentDetails() resolves to it and
 * UC_CONSENT's detail carries it; undefined while the visitor hasn't answered (consent.required).
 * `where` names details in the errors. Throws ConsentError on details that aren't an object with
 * consent.required a boolean and services an object of entries, each with a category and, when it
 * has a consent, a boolean given and an EXPLICIT or IMPLICIT type.
 */
export function usercentricsV3Signal(details: unknown, where: string): ConsentSignal | undefined {
  if (!isRecord(details)) throw new ConsentError(`${where} is not an object`);
  const { consent, services } = details;
  if (!isRecord(consent)) throw new ConsentError(`${where}.consent is not an object`);
  const required = consent.required;
  if (typeof required !== "boolean") throw new ConsentError(`${where}.consent.required is not a boolean: ${String(required)}`);
  if (required) return undefined;
  if (!isRecord(services)) throw new ConsentError(`${where}.services is not an object`);
  const counts: Counts = {};
  for (const id of Object.keys(services)) {
    const at = `${where}.services[${JSON.stringify(id)}]`;
    const service = services[id];
    if (!isRecord(service)) throw new ConsentError(`${at} is not an object`);
    const category = service.category;
    if (typeof category !== "string") throw new ConsentError(`${at}.category is not a string: ${String(category)}`);
    count(counts, category, explicitlyGivenV3(service, at));
  }
  return signalOf(counts);
}

/**
 * Follows Usercentrics on win: its consent now, if the visitor has answered, and after each of its
 * events. Each read runs inside the core's boundary (api.guard), and so does what a v3 promise
 * resolves or rejects with.
 */
export function watchUsercentrics(win: UsercentricsHost, api: AdapterApi): void {
  /** The latest read's number; a v3 read whose promise resolves after a newer read is dropped. */
  let latest = 0;
  const apply = (signal: ConsentSignal | undefined): void => {
    if (signal) api.signal(signal);
  };
  const readV3 = (cmp: unknown): void => {
    if (!isRecord(cmp)) throw new ConsentError("window.__ucCmp is not an object");
    const ucCmp = cmp;
    const readId = ++latest;
    Promise.resolve(call(ucCmp, "window.__ucCmp", "isInitialized"))
      .then((initialized) => {
        if (typeof initialized !== "boolean") {
          throw new ConsentError(`window.__ucCmp.isInitialized() is not a boolean: ${String(initialized)}`);
        }
        // Not initialized yet: UC_UI_INITIALIZED and UC_CONSENT follow once it is.
        if (!initialized) return;
        // Whatever getConsentDetails() resolves to, undefined included, is read as ConsentDetails.
        return Promise.resolve(call(ucCmp, "window.__ucCmp", "getConsentDetails")).then((details) =>
          api.guard(() => {
            if (readId === latest) apply(usercentricsV3Signal(details, "window.__ucCmp.getConsentDetails()"));
          }),
        );
      })
      .then(undefined, (error: unknown) =>
        api.guard(() => {
          throw error;
        }),
      );
  };
  const read = (): void =>
    api.guard(() => {
      if (win.__ucCmp !== undefined) readV3(win.__ucCmp);
      else if (win.UC_UI !== undefined) apply(usercentricsSignal(win.UC_UI));
    });
  for (const type of USERCENTRICS_EVENTS) win.addEventListener(type, read);
  win.addEventListener(USERCENTRICS_CONSENT_EVENT, (event?: unknown) =>
    api.guard(() => {
      if (win.__ucCmp === undefined) return;
      latest++;
      const detail = isRecord(event) ? event.detail : undefined;
      apply(usercentricsV3Signal(detail, "UC_CONSENT's event.detail"));
    }),
  );
  read();
}
