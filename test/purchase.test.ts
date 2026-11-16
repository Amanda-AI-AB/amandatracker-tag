// amanda('purchase') (AAI-802): the command that hands over a purchase event, its order held to the
// wire schema's Purchase; under granted consent a purchase event the schema accepts, and in declined
// mode `pings` a count-only ping without any of the order's fields.
import { afterEach, describe, expect, it, vi } from "vitest";
import { boot } from "../src/core/boot";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import { declinedMode } from "../src/core/config";
import { createConsent, type Consent, type ConsentMachine } from "../src/core/consent";
import type { PageviewInput } from "../src/core/pageview";
import { pingOf } from "../src/core/ping";
import { checkPurchase, purchaseCommand, type PurchaseInput } from "../src/core/purchase";
import { CommandError, type AmandaFunction } from "../src/core/queue";
import type { Purchase, WirePing } from "../src/wire/generated";
import { buildEvent, buildPurchase, WirePayloadError } from "../src/wire/payload";
import { fakeWindow, jsonResponse, PAGE, scriptTag } from "./fake-window";
import { UUID7, validator } from "./wire-validator";

const SNIPPET = { src: "https://eu.serversider.com/a.js", "data-site": "site_123" };
const START = 1_731_400_000_000;
const CONFIG = { schema_version: 1, site: "site_123", config_version: 7 };
const PINGS = { ...CONFIG, consent: { declined_mode: "pings" } };
const IDS = { visitor_id: "01934f6c-8d2a-7b3c-8d4e-5f6a7b8c9d01", session_id: "01934f6c-8d2a-7b3c-ad4e-5f6a7b8c9d02" };

const ORDER = {
  order_id: "1001",
  revenue: 249.9,
  currency: "SEK",
  items: [
    { sku: "TSH-RED-M", name: "T-shirt, red, M", qty: 2, price: 99.95 },
    { sku: "CAP-01", qty: 1, price: 50 },
  ],
};

const validateEvent = validator("event.json");
const validatePing = validator("ping.json");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Item = PageviewInput | PurchaseInput;

function stub(queued: unknown[][]): AmandaFunction {
  const amanda: AmandaFunction = function (...args: unknown[]) {
    (amanda.q = amanda.q || []).push(args);
  };
  amanda.q = queued;
  return amanda;
}

/** A booted page whose purchases go to `purchases`, or, with a config, through the consent machine. */
function purchasePage(options: { config?: object; withSink?: boolean; queued?: unknown[][]; consent?: boolean } = {}) {
  const { config = CONFIG, withSink = true, queued = [], consent = false } = options;
  const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(config));
  if (queued.length > 0) win.amanda = stub(queued);
  const reports: ErrorReport[] = [];
  const purchases: PurchaseInput[] = [];
  const identified: { item: Item; consent: Consent }[] = [];
  const pings: WirePing[] = [];
  let machine: ConsentMachine<Item> | undefined;
  const boundary = new ErrorBoundary((report) => reports.push(report), 1);
  const booted = boot(win, {
    tagVersion: "0.2.0",
    boundary,
    onPageview: (input) => machine?.collect(input),
    ...(withSink ? { onPurchase: (input: PurchaseInput) => (machine ? machine.collect(input) : purchases.push(input)) } : {}),
    ...(consent
      ? {
          consent: (siteConfig) => {
            machine = createConsent<Item>({
              declinedMode: declinedMode(siteConfig),
              sink: {
                identified: (item, snapshot) => identified.push({ item, consent: snapshot }),
                anonymous: (item) => pings.push(pingOf(item, UUID7)),
                withdraw: () => undefined,
              },
              identity: { forget: () => undefined, renew: () => undefined },
            });
            return machine;
          },
        }
      : {}),
    now: () => START,
  });
  return { win, booted, reports, purchases, identified, pings };
}

describe("amanda('purchase') (AAI-802)", () => {
  it("hands over a purchase event with the order", async () => {
    const { win, booted, reports, purchases } = purchasePage();
    await booted;

    win.amanda!("purchase", ORDER);

    expect(reports).toEqual([]);
    expect(purchases).toEqual([
      {
        type: "purchase",
        site_id: "site_123",
        tag_version: "0.2.0",
        client_ts: START,
        url: `${PAGE}/products?id=1`,
        page_title: "Products",
        language: "sv-SE",
        purchase: ORDER,
      },
    ]);
  });

  it("under granted consent emits a purchase event with order_id, revenue, currency and items, valid against the schema", async () => {
    const { win, booted, reports, identified, pings } = purchasePage({ consent: true });
    await booted;

    win.amanda!("consent", { analytics: "granted", ads: "granted" });
    win.amanda!("purchase", ORDER);

    expect(reports).toEqual([]);
    expect(pings).toEqual([]);
    const purchases = identified.filter(({ item }) => item.type === "purchase");
    expect(purchases).toHaveLength(1);
    const { item, consent } = purchases[0]!;
    const event = buildEvent({ ...(item as PurchaseInput), ...IDS, consent });
    expect(validateEvent(event), JSON.stringify(validateEvent.errors)).toBe(true);
    expect(event).toMatchObject({ type: "purchase", purchase: ORDER, consent: { analytics: "granted" } });
  });

  it("in declined mode pings sends a count-only ping: no order_id, revenue, currency or items", async () => {
    const { win, booted, reports, identified, pings } = purchasePage({ config: PINGS, consent: true });
    await booted;

    win.amanda!("consent", { analytics: "denied", ads: "denied" });
    win.amanda!("purchase", ORDER);

    expect(reports).toEqual([]);
    expect(identified).toEqual([]);
    const purchase = pings.filter((ping) => ping.type === "purchase");
    expect(purchase).toEqual([{ schema_version: 1, event_id: UUID7, site_id: "site_123", type: "purchase", path: "/products" }]);
    expect(validatePing(purchase[0]), JSON.stringify(validatePing.errors)).toBe(true);
    expect(JSON.stringify(pings)).not.toMatch(/1001|249\.9|SEK|TSH|order_id|revenue|currency|items/);
  });

  it("runs a purchase call the snippet queued before the tag loaded", async () => {
    const { booted, purchases } = purchasePage({ queued: [["purchase", ORDER]] });
    await booted;

    expect(purchases.map((input) => input.purchase.order_id)).toEqual(["1001"]);
  });

  it("refuses an order the schema refuses, reports it naming the field, and sends nothing", async () => {
    const { win, booted, reports, purchases } = purchasePage();
    await booted;

    win.amanda!("purchase", { ...ORDER, revenue: "249.90" });

    expect(purchases).toEqual([]);
    expect(reports).toEqual([
      { stage: "command", name: "CommandError", message: "amanda('purchase', order) refuses the order: event.purchase.revenue is not a finite number" },
    ]);
  });

  it("has no purchase command without a sink", async () => {
    const { win, booted, reports } = purchasePage({ withSink: false });
    await booted;

    win.amanda!("purchase", ORDER);

    expect(reports).toEqual([{ stage: "command", name: "CommandError", message: "unknown command: purchase" }]);
  });
});

describe("checkPurchase", () => {
  it("takes an order as the schema has it, items optional", () => {
    expect(checkPurchase(ORDER)).toEqual(ORDER);
    expect(checkPurchase({ order_id: "1002", revenue: 0, currency: "EUR" })).toEqual({ order_id: "1002", revenue: 0, currency: "EUR" });
  });

  it("upper-cases a currency given in lower case", () => {
    expect(checkPurchase({ ...ORDER, currency: "sek" }).currency).toBe("SEK");
  });

  it("returns a copy: changing the order afterwards changes nothing", () => {
    const order = { ...ORDER, items: ORDER.items.map((item) => ({ ...item })) };
    const kept = checkPurchase(order);
    order.items[0]!.qty = 99;
    expect(kept.items![0]!.qty).toBe(2);
  });

  it("leaves out keys the schema doesn't list, with a warning naming them", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const kept = checkPurchase({ ...ORDER, coupon: "NOV10", items: [{ ...ORDER.items[0], color: "red" }] });

    expect(kept).toEqual({ ...ORDER, items: [ORDER.items[0]] });
    expect(warning).toHaveBeenCalledTimes(1);
    expect(String(warning.mock.calls[0]![0])).toContain("coupon, items[0].color");
  });

  it.each([
    ["no order", undefined],
    ["null", null],
    ["an array", [ORDER]],
    ["a string", "1001"],
    ["no order_id", { revenue: 1, currency: "SEK" }],
    ["an empty order_id", { ...ORDER, order_id: "" }],
    ["a numeric order_id", { ...ORDER, order_id: 1001 }],
    ["an order_id over 128 characters", { ...ORDER, order_id: "x".repeat(129) }],
    ["no revenue", { order_id: "1", currency: "SEK" }],
    ["a revenue given as a string", { ...ORDER, revenue: "249.90" }],
    ["a NaN revenue", { ...ORDER, revenue: NaN }],
    ["a negative revenue", { ...ORDER, revenue: -1 }],
    ["no currency", { order_id: "1", revenue: 1 }],
    ["a currency that isn't three letters", { ...ORDER, currency: "KRONA" }],
    ["items given as an object", { ...ORDER, items: ORDER.items[0] }],
    ["an item that isn't an object", { ...ORDER, items: ["TSH-RED-M"] }],
    ["an item without a sku", { ...ORDER, items: [{ qty: 1, price: 1 }] }],
    ["a qty of 1.5", { ...ORDER, items: [{ sku: "A", qty: 1.5, price: 1 }] }],
    ["a qty of 0", { ...ORDER, items: [{ sku: "A", qty: 0, price: 1 }] }],
    ["a negative price", { ...ORDER, items: [{ sku: "A", qty: 1, price: -1 }] }],
    ["more than 50 items", { ...ORDER, items: Array.from({ length: 51 }, () => ({ sku: "A", qty: 1, price: 1 })) }],
  ])("refuses %s with a CommandError", (_, order) => {
    expect(() => checkPurchase(order)).toThrow(CommandError);
  });

  it("never quotes the order's values in its refusal", () => {
    expect(() => checkPurchase({ ...ORDER, order_id: "anna@example.se".repeat(10) })).toThrow(/^(?!.*anna).*order_id is over its cap/);
  });
});

describe("purchaseCommand", () => {
  it("takes exactly one argument", () => {
    const sent: Purchase[] = [];
    const command = purchaseCommand((purchase) => sent.push(purchase));

    expect(() => command()).toThrow(CommandError);
    expect(() => command(ORDER, { extra: true })).toThrow(CommandError);
    command(ORDER);
    expect(sent).toEqual([ORDER]);
  });
});

describe("buildPurchase", () => {
  it("keeps an order to the schema's Purchase, as buildEvent does", () => {
    expect(buildPurchase({ ...ORDER, currency: "sek", items: [] })).toEqual({ order_id: "1001", revenue: 249.9, currency: "SEK" });
  });

  it("throws WirePayloadError on an order that isn't an object", () => {
    expect(() => buildPurchase(null)).toThrow(WirePayloadError);
    expect(() => buildPurchase([ORDER])).toThrow("event.purchase is not an object");
  });
});
