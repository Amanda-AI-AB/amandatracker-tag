import { afterEach, describe, expect, it, vi } from "vitest";
import { boot } from "../src/core/boot";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import { ga4Event, mapGa4Event, MAX_PURCHASE_ITEMS, watchEcommerce, type EcommerceInput, type EcommerceMapping } from "../src/core/ecommerce";
import { buildEvent, type EventInput } from "../src/wire/payload";
import { fakeWindow, jsonResponse, PAGE, scriptTag } from "./fake-window";
import { validator } from "./wire-validator";

const CONFIG = { schema_version: 1, site: "site_123", config_version: 7 };
const SNIPPET = { src: "https://eu.serversider.com/a.js", "data-site": "site_123" };
const START = 1_731_400_000_000;

/** GA4's sample items, as a shop's dataLayer gives them. */
const SHIRT = { item_id: "SKU_12345", item_name: "Stan and Friends Tee", price: 10.01, quantity: 3, item_brand: "Google", discount: 2.22 };
const MUG = { item_id: 67890, item_name: "Mug", price: "4.50" };

/** GA4's purchase params, as a shop's dataLayer gives them. */
const PURCHASE_PARAMS = { transaction_id: "T_12345", value: 34.53, tax: 4.9, shipping: 5.99, currency: "usd", coupon: "SUMMER", items: [SHIRT, MUG] };

/** A GTM-style dataLayer entry. */
function gtm(event: string, ecommerce: unknown): Record<string, unknown> {
  return { event, ecommerce };
}

/** A gtag.js dataLayer entry: gtag pushes its arguments object. */
function gtag(..._args: unknown[]): IArguments {
  return arguments;
}

/** The wire event of a mapped input, once identity and consent have made it one. */
function wireEvent(input: EcommerceInput) {
  return buildEvent({
    ...input,
    visitor_id: "01934f6c-8d2a-7b3c-8d4e-5f6a7b8c9d01",
    session_id: "01934f6c-8d2a-7b3c-ad4e-5f6a7b8c9d02",
    consent: { analytics: "granted", ads: "granted" },
  } as EventInput);
}

/** A booted tag with onEcommerce on a page whose dataLayer starts as layer. */
function shop(layer?: unknown, onEcommerce: boolean | ((input: EcommerceInput) => void) = true) {
  const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(CONFIG));
  if (layer !== undefined) win.dataLayer = layer;
  const reports: ErrorReport[] = [];
  const events: EcommerceInput[] = [];
  const boundary = new ErrorBoundary((report) => reports.push(report), 1);
  const handler = typeof onEcommerce === "function" ? onEcommerce : (input: EcommerceInput) => events.push(input);
  const booted = boot(win, {
    tagVersion: "0.2.0",
    boundary,
    onPageview: () => undefined,
    ...(onEcommerce === false ? {} : { onEcommerce: handler }),
    now: () => START,
  });
  const push = (...entries: unknown[]) => (win.dataLayer as unknown[]).push(...entries);
  return { win, booted, reports, events, push };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GA4 e-commerce auto-map (AAI-195)", () => {
  it("makes a GA4-tagged shop's funnel into Amanda events with no more tagging, each valid on the wire", async () => {
    const { booted, events, push, reports } = shop();
    await booted;

    push(gtm("view_item", { currency: "SEK", value: 10.01, items: [SHIRT] }));
    push({ ecommerce: null });
    push(gtm("add_to_cart", { currency: "SEK", value: 30.03, items: [SHIRT] }));
    push(gtm("begin_checkout", { currency: "SEK", value: 34.53, items: [SHIRT, MUG] }));
    push(gtm("purchase", PURCHASE_PARAMS));

    expect(events.map((e) => e.type)).toEqual(["view_item", "add_to_cart", "begin_checkout", "purchase"]);
    expect(events[0]).toEqual({
      type: "view_item",
      site_id: "site_123",
      tag_version: "0.2.0",
      client_ts: START,
      url: `${PAGE}/products?id=1`,
      page_title: "Products",
      language: "sv-SE",
      props: { currency: "SEK", value: 10.01, item_count: 1, item_id: "SKU_12345", item_name: "Stan and Friends Tee" },
    });
    expect(events[2]).toMatchObject({ props: { currency: "SEK", value: 34.53, item_count: 2 } });
    expect(events[2]).not.toHaveProperty("props.item_id");
    expect(events[3]).toMatchObject({
      purchase: {
        order_id: "T_12345",
        revenue: 34.53,
        currency: "USD",
        items: [
          { sku: "SKU_12345", name: "Stan and Friends Tee", qty: 3, price: 10.01 },
          { sku: "67890", name: "Mug", qty: 1, price: 4.5 },
        ],
      },
    });
    const validate = validator("event.json");
    for (const input of events) {
      const event = wireEvent(input);
      expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
    }
    expect(reports).toEqual([]);
  });

  it("reads gtag.js's events as well as GTM's", async () => {
    const { booted, events, push } = shop();
    await booted;

    push(gtag("event", "add_to_cart", { currency: "EUR", value: 9, items: [MUG] }));
    push(gtag("event", "purchase", PURCHASE_PARAMS));

    expect(events.map((e) => e.type)).toEqual(["add_to_cart", "purchase"]);
    expect(events[0]).toMatchObject({ props: { currency: "EUR", value: 9, item_count: 1, item_id: "67890", item_name: "Mug" } });
    expect(events[1]).toMatchObject({ purchase: { order_id: "T_12345", currency: "USD" } });
  });

  it("reads the events already in the dataLayer at boot once, then each one pushed later", async () => {
    const { booted, events, push } = shop([gtm("view_item", { items: [SHIRT] })]);
    await booted;

    push(gtm("add_to_cart", { items: [SHIRT] }));

    expect(events.map((e) => e.type)).toEqual(["view_item", "add_to_cart"]);
    expect(events[0]).toMatchObject({ props: { item_count: 1 } });
    expect(events[0]).not.toHaveProperty("props.value");
  });

  it("leaves the page's own push working: what it returns, and what the dataLayer holds", async () => {
    const page: unknown[] = [];
    const { booted, push } = shop(page);
    await booted;

    expect(push({ event: "gtm.click" }, gtm("view_item", { items: [] }))).toBe(2);
    expect(page.slice()).toEqual([{ event: "gtm.click" }, gtm("view_item", { items: [] })]);
  });

  it("is off by default: without onEcommerce, the dataLayer is neither read nor wrapped", async () => {
    const layer: unknown[] = [gtm("purchase", PURCHASE_PARAMS)];
    const push = layer.push;
    const { booted } = shop(layer, false);
    await booted;

    expect(layer.push).toBe(push);
  });

  it("reads nothing until the tag has booted", () => {
    const { win, events } = shop();

    win.dataLayer = [gtm("purchase", PURCHASE_PARAMS)];

    expect(events).toEqual([]);
  });

  it("ignores every other GA4 event and dataLayer entry", async () => {
    const { booted, events, push } = shop();
    await booted;

    push(
      gtm("view_item_list", { items: [SHIRT] }),
      gtm("add_payment_info", { items: [SHIRT] }),
      gtag("event", "refund", PURCHASE_PARAMS),
      gtag("consent", "update", { analytics_storage: "granted" }),
      gtag("config", "G-XXXX"),
      { event: "gtm.js" },
      "purchase",
      null,
    );

    expect(events).toEqual([]);
  });

  it("reports a failure in the handover instead of throwing it into the page, and still reads the next entry", async () => {
    let calls = 0;
    const { booted, reports, push } = shop(undefined, () => {
      calls += 1;
      throw new TypeError("boom");
    });
    await booted;

    expect(() => push(gtm("view_item", { items: [] }), gtm("add_to_cart", { items: [] }))).not.toThrow();

    expect(calls).toBe(2);
    expect(reports).toEqual([
      { stage: "pageview", name: "TypeError", message: "boom" },
      { stage: "pageview", name: "TypeError", message: "boom" },
    ]);
  });

  it("reports a dataLayer that is not an array, and still boots", async () => {
    const { booted, reports } = shop({ not: "an array" });

    expect(await booted).toBeDefined();
    expect(reports).toEqual([
      { stage: "pageview", name: "EcommerceError", message: "window.dataLayer is not an array; GA4 e-commerce events are not read" },
    ]);
  });
});

describe("mapGa4Event", () => {
  /** What entry maps to, with the console's warnings. */
  function map(entry: unknown): { mapping: EcommerceMapping | undefined; warnings: string[] } {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const mapping = mapGa4Event(entry);
    const warnings = warn.mock.calls.map((call) => String(call[0]));
    warn.mockRestore();
    return { mapping, warnings };
  }

  it("maps a purchase without items to an order without items", () => {
    const { mapping, warnings } = map(gtm("purchase", { transaction_id: 1001, value: "12.50", currency: "sek" }));

    expect(mapping).toEqual({ type: "purchase", purchase: { order_id: "1001", revenue: 12.5, currency: "SEK" } });
    expect(warnings).toEqual([]);
  });

  it.each([
    ["without a transaction_id", { value: 1, currency: "SEK" }],
    ["with an empty transaction_id", { transaction_id: "", value: 1, currency: "SEK" }],
    ["without a value", { transaction_id: "T1", currency: "SEK" }],
    ["with a negative value", { transaction_id: "T1", value: -1, currency: "SEK" }],
    ["with a value that is no number", { transaction_id: "T1", value: "12,50", currency: "SEK" }],
    ["without a currency", { transaction_id: "T1", value: 1 }],
    ["with a currency that is no ISO code", { transaction_id: "T1", value: 1, currency: "kr" }],
  ])("never guesses a purchase %s: it is not sent, with a warning", (_case, params) => {
    const { mapping, warnings } = map(gtm("purchase", params));

    expect(mapping).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it.each([
    ["an item without an item_id", [{ item_name: "Tee", price: 1 }]],
    ["an item without a price", [{ item_id: "A", quantity: 1 }]],
    ["an item of quantity 0", [{ item_id: "A", price: 1, quantity: 0 }]],
    ["an item of a fractional quantity", [{ item_id: "A", price: 1, quantity: 1.5 }]],
    ["an item that is no object", ["A"]],
    [`more than ${MAX_PURCHASE_ITEMS} items`, Array.from({ length: MAX_PURCHASE_ITEMS + 1 }, (_, i) => ({ item_id: `A${i}`, price: 1 }))],
  ])("sends a purchase with %s without its items, with a warning", (_case, items) => {
    const { mapping, warnings } = map(gtm("purchase", { transaction_id: "T1", value: 1, currency: "SEK", items }));

    expect(mapping).toEqual({ type: "purchase", purchase: { order_id: "T1", revenue: 1, currency: "SEK" } });
    expect(warnings).toHaveLength(1);
  });

  it("sends a purchase's 50 items", () => {
    const items = Array.from({ length: MAX_PURCHASE_ITEMS }, (_, i) => ({ item_id: `A${i}`, price: 1 }));
    const { mapping } = map(gtm("purchase", { transaction_id: "T1", value: 50, currency: "SEK", items }));

    expect(mapping?.type === "purchase" && mapping.purchase.items).toHaveLength(MAX_PURCHASE_ITEMS);
  });

  it("leaves out of props a currency that is no ISO code and a value that is no number", () => {
    const { mapping } = map(gtm("view_item", { currency: "kronor", value: "lots", items: [] }));

    expect(mapping).toEqual({ type: "view_item", props: { item_count: 0 } });
  });

  it("never reads an item's other fields into props", () => {
    const { mapping } = map(gtm("view_item", { items: [SHIRT] }));

    expect(mapping).toEqual({ type: "view_item", props: { item_count: 1, item_id: "SKU_12345", item_name: "Stan and Friends Tee" } });
  });

  it("does not send a GA4 event without its params, with a warning", () => {
    expect(map({ event: "add_to_cart" })).toEqual({ mapping: undefined, warnings: ["amanda: GA4 event add_to_cart without its e-commerce params is not sent"] });
    expect(map(gtag("event", "begin_checkout")).mapping).toBeUndefined();
  });

  it("ignores an entry whose event names an inherited property", () => {
    expect(ga4Event({ event: "toString", ecommerce: {} })).toBeUndefined();
    expect(ga4Event(["event", "constructor", {}])).toBeUndefined();
  });
});

describe("watchEcommerce", () => {
  it("defines the dataLayer when the page has none, so a gtag loaded later pushes to the one it watches", () => {
    const host: { dataLayer?: unknown } = {};
    const seen: EcommerceMapping[] = [];
    watchEcommerce(host, new ErrorBoundary(() => undefined, 1), (mapping) => seen.push(mapping));

    (host.dataLayer as unknown[]).push(gtag("event", "view_item", { items: [] }));

    expect(seen).toEqual([{ type: "view_item", props: { item_count: 0 } }]);
  });
});
