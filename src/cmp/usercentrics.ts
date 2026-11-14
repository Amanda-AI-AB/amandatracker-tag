// Usercentrics, for sites whose Usercentrics (its Browser UI, v2) is set up without Consent Mode or
// TCF (02 §3.4): the usercentrics adapter (src/adapters/usercentrics.ts) reads window.UC_UI once it
// connects, and again on each UC_UI_INITIALIZED, which Usercentrics fires once it is ready, and
// each UC_UI_CMP_EVENT, which it fires on the visitor's choices in its banner: accept, reject and
// change. A read that repeats the last one changes nothing.
//
// Usercentrics keeps consent per service, each in a category: analytics is its default Functional
// category (slug `functional`, "to analyse the use of the website"), and ads its Marketing one
// (`marketing`). A category is granted only when it has services and the visitor explicitly
// consented to every one of them (each service's latest consent history entry is `explicit`, its
// status true); anything less is denied. A visitor who hasn't answered the banner yet
// (UC_UI.isConsentRequired() is not false) has decided nothing, whatever the services' defaults
// say meanwhile: the signal is none, and the state stays unknown, never assumed granted or denied
// (08 R11).

import type { AdapterApi } from "../core/adapter-api";
import { ConsentError, type Category, type ConsentSignal } from "../core/consent";

/** The page's window, as far as Usercentrics goes. */
export interface UsercentricsHost {
  UC_UI?: unknown;
  addEventListener(type: string, listener: () => void): void;
}

/** The Usercentrics category (its slug) each consent category reads. */
export const USERCENTRICS_CATEGORIES: Readonly<Record<Category, string>> = { analytics: "functional", ads: "marketing" };

/** The window events after which the adapter reads UC_UI again. */
export const USERCENTRICS_EVENTS: readonly string[] = ["UC_UI_INITIALIZED", "UC_UI_CMP_EVENT"];

/** Calls UC_UI's method `name`, throwing ConsentError when it has none. */
function call(ui: Record<string, unknown>, name: string): unknown {
  const method = ui[name];
  if (typeof method !== "function") throw new ConsentError(`window.UC_UI.${name} is not a function`);
  return (method as () => unknown).call(ui);
}

/** Whether the visitor explicitly consented to service, one of getServicesBaseInfo()'s entries. */
function explicitlyGranted(service: unknown, index: number): boolean {
  const where = `window.UC_UI.getServicesBaseInfo()[${index}]`;
  const consent = typeof service === "object" && service !== null ? (service as Record<string, unknown>).consent : undefined;
  if (typeof consent !== "object" || consent === null) throw new ConsentError(`${where} has no consent`);
  const { status, history } = consent as Record<string, unknown>;
  if (typeof status !== "boolean") throw new ConsentError(`${where}.consent.status is not a boolean: ${String(status)}`);
  if (!Array.isArray(history)) throw new ConsentError(`${where}.consent.history is not an array`);
  const latest: unknown = history[history.length - 1];
  return status && typeof latest === "object" && latest !== null && (latest as Record<string, unknown>).type === "explicit";
}

/**
 * The signal window.UC_UI gives; undefined while the visitor hasn't answered. Throws ConsentError
 * on a UC_UI that isn't an object or lacks isConsentRequired() or getServicesBaseInfo(), or whose
 * services aren't a list of entries, each with a category slug and a consent status and history.
 */
export function usercentricsSignal(ui: unknown): ConsentSignal | undefined {
  if (typeof ui !== "object" || ui === null) throw new ConsentError("window.UC_UI is not an object");
  const api = ui as Record<string, unknown>;
  if (call(api, "isConsentRequired") !== false) return undefined;
  const services = call(api, "getServicesBaseInfo");
  if (!Array.isArray(services)) throw new ConsentError("window.UC_UI.getServicesBaseInfo() is not an array");
  const counts: { [slug: string]: { services: number; granted: number } } = {};
  services.forEach((service: unknown, index) => {
    const slug = typeof service === "object" && service !== null ? (service as Record<string, unknown>).categorySlug : undefined;
    if (typeof slug !== "string") {
      throw new ConsentError(`window.UC_UI.getServicesBaseInfo()[${index}].categorySlug is not a string: ${String(slug)}`);
    }
    const count = (counts[slug] = counts[slug] || { services: 0, granted: 0 });
    count.services++;
    if (explicitlyGranted(service, index)) count.granted++;
  });
  const signal: ConsentSignal = {};
  for (const category of ["analytics", "ads"] as const) {
    const count = counts[USERCENTRICS_CATEGORIES[category]];
    signal[category] = count !== undefined && count.granted === count.services ? "granted" : "denied";
  }
  return signal;
}

/**
 * Follows Usercentrics on win: its consent now, if the visitor has answered, and on each
 * UC_UI_INITIALIZED or UC_UI_CMP_EVENT after. Each read runs inside the core's boundary (api.guard).
 */
export function watchUsercentrics(win: UsercentricsHost, api: AdapterApi): void {
  const read = (): void =>
    api.guard(() => {
      if (win.UC_UI === undefined) return;
      const signal = usercentricsSignal(win.UC_UI);
      if (signal) api.signal(signal);
    });
  for (const type of USERCENTRICS_EVENTS) win.addEventListener(type, read);
  read();
}
