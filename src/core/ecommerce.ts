// GA4 e-commerce auto-map (01 §4, AAI-195): on a shop already tagged for GA4, the tag reads GA4's
// e-commerce events from window.dataLayer and maps them to its own, so the shop needs no more
// tagging. It is off unless configured: the tag reads nothing of them unless its boot is handed
// onEcommerce. a.js doesn't hand it over yet: the per-site toggle that turns it on is a follow-up.
//
// The mapping is explicit, never a guess. Only these four GA4 events are read, each to an event of
// the same name:
//
//   view_item, add_to_cart, begin_checkout -> props: currency (upper case) and value, when GA4's
//     params give them; item_count, the number of items; and, for an event of exactly one item,
//     its item_id and item_name. Nothing else of the items is read.
//   purchase -> a purchase: order_id from transaction_id, revenue from value, currency from
//     currency, and items, each with sku from item_id, name from item_name, qty from quantity
//     (1 when GA4's item leaves it out, as GA4 counts it) and price from price.
//
// A purchase without a transaction_id, a value of 0 or more, or a currency of three letters is not
// sent, with a console warning: an order the processor can't deduplicate or total would be a
// guess. A purchase's items go only when every one maps (item_id, a whole quantity of 1 or more,
// a price of 0 or more) and there are at most 50 of them; otherwise the purchase goes without
// items, with a warning, since a partial list would misstate the order. A number may be given as a
// number or as a decimal string ("12.50"), as dataLayers often do; nothing else is coerced.
//
// GA4's events reach the dataLayer in two shapes, and both are read:
//   Google Tag Manager: dataLayer.push({ event: "purchase", ecommerce: { transaction_id, ... } })
//   gtag.js:            gtag("event", "purchase", { transaction_id, ... })
// Entries already in the dataLayer at boot are read once, then each one pushed later. Any other
// entry is ignored, GTM's `{ ecommerce: null }` reset included. A page that sends one event both
// ways sends it twice; the processor deduplicates purchases by order_id (AAI-104).

import type { Purchase, PurchaseItem } from "../wire/generated";
import { warn, type ErrorBoundary } from "./boundary";
import { pageviewInput, type PageSource, type PageviewInput } from "./pageview";

/** GA4's e-commerce events the tag reads, and the event each maps to. */
export const GA4_EVENT_MAP = {
  view_item: "view_item",
  add_to_cart: "add_to_cart",
  begin_checkout: "begin_checkout",
  purchase: "purchase",
} as const;

export type Ga4EventName = keyof typeof GA4_EVENT_MAP;

/** The most items a purchase carries: the wire's Purchase.items cap. */
export const MAX_PURCHASE_ITEMS = 50;

/** The props a mapped view_item, add_to_cart or begin_checkout carries, those GA4 gave. */
export type EcommerceProps = {
  readonly currency?: string;
  readonly value?: number;
  readonly item_count: number;
  readonly item_id?: string;
  readonly item_name?: string;
};

/** What a GA4 e-commerce event maps to: a tracked event's props, or a purchase's order. */
export type EcommerceMapping =
  | { readonly type: "view_item" | "add_to_cart" | "begin_checkout"; readonly props: EcommerceProps }
  | { readonly type: "purchase"; readonly purchase: Purchase };

/** A mapped event's page fields, as pageviewInput reads them, and its props or its order. */
export type EcommerceInput = Omit<PageviewInput, "type" | "referrer" | "attribution"> & EcommerceMapping;

/** What the e-commerce watcher reads: window, or a stand-in for it in tests. */
export interface EcommerceHost {
  dataLayer?: unknown;
}

export class EcommerceError extends Error {
  override name = "EcommerceError";
}

const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const CURRENCY = /^[A-Za-z]{3}$/;

/** value as a finite number: a number, or a decimal string; undefined for anything else. */
function numberOf(value: unknown): number | undefined {
  if (typeof value === "number") return isFinite(value) ? value : undefined;
  if (typeof value === "string" && DECIMAL.test(value.trim())) return Number(value.trim());
  return undefined;
}

/** value as an id: a non-empty string, or a finite number as its decimal string. */
function idOf(value: unknown): string | undefined {
  if (typeof value === "string") return value === "" ? undefined : value;
  if (typeof value === "number" && isFinite(value)) return String(value);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isGa4Event(name: unknown): name is Ga4EventName {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(GA4_EVENT_MAP, name);
}

/**
 * The GA4 e-commerce event a dataLayer entry holds, its name and params, in either shape the file's
 * header names; undefined for any other entry.
 */
export function ga4Event(entry: unknown): { readonly name: Ga4EventName; readonly params: unknown } | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const command = entry as ArrayLike<unknown>;
  if (typeof command.length === "number") {
    if (command[0] !== "event" || !isGa4Event(command[1])) return undefined;
    return { name: command[1], params: command[2] };
  }
  const pushed = entry as Record<string, unknown>;
  if (!isGa4Event(pushed.event)) return undefined;
  return { name: pushed.event, params: pushed.ecommerce };
}

/** The items GA4's params list, or an empty list when they list none. */
function itemsOf(params: Record<string, unknown>): readonly unknown[] {
  return Array.isArray(params.items) ? params.items : [];
}

/** One GA4 item as a purchase's line, or undefined when it doesn't map (the file's header). */
function purchaseItem(item: unknown): PurchaseItem | undefined {
  if (!isRecord(item)) return undefined;
  const sku = idOf(item.item_id);
  const qty = item.quantity === undefined ? 1 : numberOf(item.quantity);
  const price = numberOf(item.price);
  if (sku === undefined || qty === undefined || !(qty >= 1) || Math.floor(qty) !== qty || price === undefined || price < 0) {
    return undefined;
  }
  const name = idOf(item.item_name);
  return name === undefined ? { sku, qty, price } : { sku, name, qty, price };
}

/** The purchase GA4's params give, or undefined, with a warning, when they don't give one. */
function purchaseOf(params: Record<string, unknown>): Purchase | undefined {
  const orderId = idOf(params.transaction_id);
  const revenue = numberOf(params.value);
  const currency = params.currency;
  if (orderId === undefined || revenue === undefined || revenue < 0 || typeof currency !== "string" || !CURRENCY.test(currency)) {
    warn("amanda: a GA4 purchase without a transaction_id, a value of 0 or more and a three-letter currency is not sent");
    return undefined;
  }
  const order = { order_id: orderId, revenue, currency: currency.toUpperCase() };
  const given = itemsOf(params);
  if (given.length === 0) return order;
  const items: PurchaseItem[] = [];
  for (const item of given) {
    const line = purchaseItem(item);
    if (line === undefined) break;
    items.push(line);
  }
  const [first, ...rest] = items;
  if (first === undefined || items.length !== given.length || items.length > MAX_PURCHASE_ITEMS) {
    warn(
      `amanda: GA4 purchase ${orderId} is sent without its items: an item lacks an item_id, a whole quantity of 1 or more ` +
        `or a price of 0 or more, or there are more than ${MAX_PURCHASE_ITEMS}`,
    );
    return order;
  }
  return { ...order, items: [first, ...rest] };
}

/** The props of a view_item, add_to_cart or begin_checkout, from GA4's params. */
function propsOf(params: Record<string, unknown>): EcommerceProps {
  const items = itemsOf(params);
  const props: { -readonly [K in keyof EcommerceProps]: EcommerceProps[K] } = { item_count: items.length };
  const currency = params.currency;
  if (typeof currency === "string" && CURRENCY.test(currency)) props.currency = currency.toUpperCase();
  const value = numberOf(params.value);
  if (value !== undefined) props.value = value;
  const only = items.length === 1 ? items[0] : undefined;
  if (isRecord(only)) {
    const id = idOf(only.item_id);
    if (id !== undefined) props.item_id = id;
    const name = idOf(only.item_name);
    if (name !== undefined) props.item_name = name;
  }
  return props;
}

/**
 * What a dataLayer entry maps to, by GA4_EVENT_MAP and the file's header: undefined for an entry
 * that is no GA4 e-commerce event, and, with a warning, for one whose params are missing or, for a
 * purchase, don't give an order.
 */
export function mapGa4Event(entry: unknown): EcommerceMapping | undefined {
  const event = ga4Event(entry);
  if (event === undefined) return undefined;
  if (!isRecord(event.params)) {
    warn(`amanda: GA4 event ${event.name} without its e-commerce params is not sent`);
    return undefined;
  }
  if (event.name === "purchase") {
    const purchase = purchaseOf(event.params);
    return purchase === undefined ? undefined : { type: "purchase", purchase };
  }
  return { type: GA4_EVENT_MAP[event.name], props: propsOf(event.params) };
}

/** The event of the page as it is now, for mapping; empty fields are left out. */
export function ecommerceInput(
  page: PageSource,
  site: string,
  tagVersion: string,
  mapping: EcommerceMapping,
  now: number = Date.now(),
): EcommerceInput {
  // A pageview's own fields stay with it: the mapping's type replaces its type.
  const { type, referrer, attribution, ...fields } = pageviewInput(page, site, tagVersion, "", now);
  return { ...fields, ...mapping };
}

/**
 * Calls onEvent with what each GA4 e-commerce event in win's dataLayer maps to: those already
 * there, then each one pushed later. Defines window.dataLayer as gtag's snippet does when the page
 * has none yet. Each push is handed to the page's push first, and its entries are read inside the
 * boundary, as stage "pageview", as a form_submit's are: a failure there is reported and never
 * reaches whoever pushed. Throws EcommerceError when window.dataLayer is not an array.
 */
export function watchEcommerce(win: EcommerceHost, boundary: ErrorBoundary, onEvent: (mapping: EcommerceMapping) => void): void {
  if (win.dataLayer === undefined) win.dataLayer = [];
  const layer = win.dataLayer;
  if (!Array.isArray(layer)) throw new EcommerceError("window.dataLayer is not an array; GA4 e-commerce events are not read");
  // Each entry on its own: one that fails is reported, and the next is still read.
  const readAll = (entries: ArrayLike<unknown>): void => {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      boundary.guard("pageview", () => {
        const mapping = mapGa4Event(entry);
        if (mapping !== undefined) onEvent(mapping);
      });
    }
  };
  readAll(layer.slice());
  const push = layer.push;
  layer.push = function (this: unknown, ...items: unknown[]): number {
    const length = push.apply(this as unknown[], items);
    readAll(items);
    return length;
  };
}
