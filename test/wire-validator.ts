// Loads one version of the wire JSON Schema into Ajv, for the tests to validate payloads with. The
// default version is the one src/wire/generated.ts was generated from, which the payload builder
// writes, and the fixtures below are payloads of it.
import { join } from "node:path";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import * as schemaFiles from "../scripts/schema-files.mjs";
import { SCHEMA_VERSION } from "../src/wire/generated";

/** A UUIDv7, the fixtures' event_id. */
export const UUID7 ="01934f6c-8d2a-7b3c-9d4e-5f6a7b8c9d0e";

/** A valid event with every field. */
export const EVENT = {
  schema_version: SCHEMA_VERSION,
  tag_version: "0.1.0",
  site_id: "site_123",
  event_id: UUID7,
  type: "pageview",
  client_ts: 1_731_400_000_000,
  url: "https://shop.example/products?id=1",
  referrer: "https://search.example/",
  page_title: "Products",
  language: "sv-SE",
  visitor_id: "01934f6c-8d2a-7b3c-8d4e-5f6a7b8c9d01",
  session_id: "01934f6c-8d2a-7b3c-ad4e-5f6a7b8c9d02",
  consent: { analytics: "granted", ads: "denied" },
  props: { plan: "pro" },
} as const;

/** A valid purchase with every field. */
export const PURCHASE = {
  ...EVENT,
  type: "purchase",
  props: { coupon: "NOV10" },
  purchase: {
    order_id: "1001",
    revenue: 249.9,
    currency: "SEK",
    items: [
      { sku: "TSH-RED-M", name: "T-shirt, red, M", qty: 2, price: 99.95 },
      { sku: "CAP-01", qty: 1, price: 50 },
    ],
  },
} as const;

/** A valid ping with every field. */
export const PING = {
  schema_version: SCHEMA_VERSION,
  event_id: UUID7,
  site_id: "site_123",
  type: "pageview",
  path: "/products",
  referrer_host: "search.example",
  utm: { source: "newsletter", medium: "email", campaign: "nov" },
} as const;

export type SchemaFile = "batch.json" | "event.json" | "ping.json" | "pubsub-message.json";

export function loadSchemas(version: number = SCHEMA_VERSION): Record<string, Record<string, unknown>> {
  return Object.fromEntries(schemaFiles.loadSchemas(join(schemaFiles.SCHEMA_ROOT, `v${version}`)));
}

export function validator(file: SchemaFile, version: number = SCHEMA_VERSION): ValidateFunction {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  for (const schema of Object.values(loadSchemas(version))) ajv.addSchema(schema);
  const validate = ajv.getSchema(`${schemaFiles.SCHEMA_BASE}/v${version}/${file}`);
  if (!validate) throw new Error(`no schema ${file} in v${version}`);
  return validate;
}
