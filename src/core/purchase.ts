// amanda('purchase') (AAI-802; 01 §4, 02 §2, 04 §3): the site's own call for an order, on its
// order confirmation page:
//
//   amanda('purchase', { order_id: '1001', revenue: 249.9, currency: 'SEK',
//                        items: [{ sku: 'TSH-RED-M', name: 'T-shirt, red, M', qty: 2, price: 99.95 }] })
//
// It hands over one purchase event carrying the order as its `purchase`, in the wire schema's
// Purchase shape (schema/v1/event.json): order_id, revenue (0 or more, in the currency's major unit),
// currency (ISO 4217, upper-cased when given in lower case) and, optionally, 1 to 50 items, each with
// sku, an optional name, a whole qty of 1 or more and a price of 0 or more. The processor
// deduplicates purchases by (site_id, order_id) (AAI-104), so a confirmation page reloaded sends the
// same order again harmlessly.
//
// The order is checked here, by the schema's own rules (buildPurchase), before anything is handed
// over: an order the collector would refuse is refused in the browser instead, with a CommandError
// reported through the boundary that names the field and never quotes its value. Nothing is coerced
// (a revenue given as "249.90" is refused): the site's own call is held to the schema, unlike GA4's
// dataLayer, which ecommerce.ts reads as GA4 writes it. A key the schema doesn't list (a coupon, a
// typo) is left out with a console warning, and the order still goes.
//
// Under granted analytics the purchase goes as an event. In declined mode `pings` the consent
// machine makes it a ping like any other item (ping.ts, pingOf), which reads only its site, type and
// page: a count-only anonymous conversion, without order_id, revenue, currency or items.

import { PURCHASE_FIELDS, PURCHASE_ITEM_FIELDS, type Purchase } from "../wire/generated";
import { buildPurchase, WirePayloadError } from "../wire/payload";
import { warn } from "./boundary";
import { pageviewInput, type PageSource, type PageviewInput } from "./pageview";
import { CommandError, type Command } from "./queue";

export const PURCHASE_COMMAND = "purchase";

/** A purchase event's page fields, as pageviewInput reads them, and its order. */
export interface PurchaseInput extends Omit<PageviewInput, "type" | "referrer" | "attribution"> {
  readonly type: "purchase";
  readonly purchase: Purchase;
}

/** The keys of value the schema's fields don't list. */
function unlisted(value: object, fields: readonly string[]): string[] {
  return Object.keys(value).filter((key) => fields.indexOf(key) === -1);
}

/**
 * order, checked and kept to the wire schema's Purchase (buildPurchase), with a console warning that
 * names any key it leaves out. Throws CommandError when the schema refuses it, naming the field.
 */
export function checkPurchase(order: unknown): Purchase {
  let purchase: Purchase;
  try {
    purchase = buildPurchase(order);
  } catch (error) {
    if (error instanceof WirePayloadError) {
      throw new CommandError(`amanda('purchase', order) refuses the order: ${error.message.replace(/^wire payload: /, "")}`);
    }
    throw error;
  }
  // buildPurchase has checked that order is an object, and its items, when an array, objects.
  const given = order as { readonly items?: unknown };
  const dropped = unlisted(given, PURCHASE_FIELDS);
  if (Array.isArray(given.items)) {
    given.items.forEach((item, index) => {
      for (const key of unlisted(item, PURCHASE_ITEM_FIELDS)) dropped.push(`items[${index}].${key}`);
    });
  }
  if (dropped.length > 0) warn(`amanda: purchase ${purchase.order_id} is sent without ${dropped.join(", ")}: the wire schema has no such field`);
  return purchase;
}

/** The purchase event of the page as it is now, with the order; empty fields are left out. */
export function purchaseInput(page: PageSource, site: string, tagVersion: string, purchase: Purchase, now: number = Date.now()): PurchaseInput {
  // A pageview's own fields stay with it: the purchase's type replaces its type.
  const { type, referrer, attribution, ...fields } = pageviewInput(page, site, tagVersion, "", now);
  return { ...fields, type: "purchase", purchase };
}

/**
 * The `purchase` command: refuses an order checkPurchase refuses; otherwise calls onPurchase with
 * the order as the schema keeps it, once per call.
 */
export function purchaseCommand(onPurchase: (purchase: Purchase) => void): Command {
  return (...args: unknown[]) => {
    if (args.length !== 1) throw new CommandError("amanda('purchase', order) takes one argument, the order");
    onPurchase(checkPurchase(args[0]));
  };
}
