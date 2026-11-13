// Loads one version of the wire JSON Schema into Ajv, for the tests to validate payloads with.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";

export const SCHEMA_ROOT = fileURLToPath(new URL("../schema", import.meta.url));
const BASE = "https://github.com/Amanda-AI-AB/amandatracker-tag/schema";

export const UUID7 = "01934f6c-8d2a-7b3c-9d4e-5f6a7b8c9d0e";

/** A valid v1 event with every field. */
export const EVENT = {
  schema_version: 1,
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

/** A valid v1 ping with every field. */
export const PING = {
  schema_version: 1,
  event_id: UUID7,
  site_id: "site_123",
  type: "pageview",
  path: "/products",
  referrer_host: "search.example",
  utm: { source: "newsletter", medium: "email", campaign: "nov" },
} as const;

export type SchemaFile = "batch.json" | "event.json" | "ping.json" | "pubsub-message.json";

export function loadSchemas(version = 1): Record<string, Record<string, unknown>> {
  const dir = join(SCHEMA_ROOT, `v${version}`);
  return Object.fromEntries(
    readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => [name, JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>]),
  );
}

export function validator(file: SchemaFile, version = 1): ValidateFunction {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  for (const schema of Object.values(loadSchemas(version))) ajv.addSchema(schema);
  const validate = ajv.getSchema(`${BASE}/v${version}/${file}`);
  if (!validate) throw new Error(`no schema ${file} in v${version}`);
  return validate;
}
