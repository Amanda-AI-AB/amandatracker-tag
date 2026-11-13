// The payload builder: it shapes what the tag sends by the wire schema's generated field lists and
// length caps (src/wire/generated.ts), so a payload carries exactly the fields the schema allows.
import {
  PURCHASE_EVENT_SHAPE,
  SCHEMA_VERSION,
  TRACKED_EVENT_SHAPE,
  WIRE_PING_SHAPE,
  type PurchaseEvent,
  type TrackedEvent,
  type WireEvent,
  type WirePing,
} from "./generated";

export type TrackedEventInput = Omit<TrackedEvent, "schema_version" | "event_id">;
export type PurchaseEventInput = Omit<PurchaseEvent, "schema_version" | "event_id">;
export type EventInput = TrackedEventInput | PurchaseEventInput;
export type PingInput = Omit<WirePing, "schema_version" | "event_id">;

const HEX = "0123456789abcdef";

/** A UUIDv7 (RFC 9562): 48 bits of Unix milliseconds, then version, variant and random bits. */
export function uuidv7(nowMs: number = Date.now(), random: Uint8Array = randomBytes(10)): string {
  if (random.length < 10) throw new Error("uuidv7 needs 10 random bytes");
  const bytes = new Uint8Array(16);
  let ms = Math.floor(nowMs);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes.set(random.subarray(0, 10), 6);
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  let out = "";
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) out += "-";
    out += HEX[bytes[i]! >> 4]! + HEX[bytes[i]! & 0x0f]!;
  }
  return out;
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/**
 * A map's rules, as generated: its key cap and pattern, its values' JSON types and their strings'
 * length cap.
 */
export interface MapShape {
  readonly maxProperties?: number;
  readonly keyPattern?: string;
  readonly values: readonly ("string" | "number" | "integer" | "boolean")[];
  readonly maxLength?: number;
}

/**
 * An object's shape, as generated: its field list, its required fields, its strings' and arrays'
 * caps, its nested objects' shapes, its arrays' item shapes and its maps' rules.
 */
export interface Shape {
  readonly fields: readonly string[];
  readonly required: readonly string[];
  readonly maxLength: Readonly<Record<string, number>>;
  readonly maxItems: Readonly<Record<string, number>>;
  readonly nested: Readonly<Record<string, Shape>>;
  readonly items: Readonly<Record<string, Shape>>;
  readonly maps: Readonly<Record<string, MapShape>>;
}

/**
 * A payload the tag can't build: a field the schema requires is missing or empty, an identifier is
 * over its cap, or a value breaks a rule the tag can't keep for it without changing what it says.
 */
export class WirePayloadError extends Error {
  constructor(
    readonly field: string,
    problem = "is required and is missing or empty",
  ) {
    super(`wire payload: ${field} ${problem}`);
    this.name = "WirePayloadError";
  }
}

/**
 * What a string over its cap becomes, by its path. `cut`: free text, cut to the cap on a whole
 * character. `subtags`: a BCP 47 tag, cut to its whole subtags that fit (RFC 4647 lookup). `drop`:
 * an optional structured value a cut would turn into another one, left out. A capped field not
 * listed here is an identifier, which a cut would silently re-target: the payload is refused. An
 * array's items are listed as `[]`, and a map's string values as `.*`.
 */
export const OVERFLOW: Readonly<Record<string, "cut" | "subtags" | "drop">> = {
  "event.url": "cut",
  "event.referrer": "cut",
  "event.page_title": "cut",
  "event.language": "subtags",
  "event.props.*": "cut",
  "event.purchase.items[].name": "cut",
  "ping.path": "cut",
  "ping.referrer_host": "drop",
  "ping.utm.source": "cut",
  "ping.utm.medium": "cut",
  "ping.utm.campaign": "cut",
  "ping.utm.term": "cut",
  "ping.utm.content": "cut",
};

/** The first `cap` UTF-16 units of value, one fewer when the cut would split a surrogate pair. */
export function cutText(value: string, cap: number): string {
  const end = cap > 0 && isHighSurrogate(value.charCodeAt(cap - 1)) ? cap - 1 : cap;
  return value.slice(0, end);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * A language tag cut to the whole subtags that fit in `cap`, as RFC 4647's lookup truncates it,
 * dropping a single-character subtag left at its end; undefined when not even the first fits.
 */
export function cutSubtags(tag: string, cap: number): string | undefined {
  const subtags = tag.split("-");
  let length = -1;
  let fit = 0;
  while (fit < subtags.length && length + 1 + subtags[fit]!.length <= cap) {
    length += 1 + subtags[fit]!.length;
    fit++;
  }
  while (fit > 1 && subtags[fit - 1]!.length === 1) fit--;
  return fit === 0 ? undefined : subtags.slice(0, fit).join("-");
}

/** value within its cap, by OVERFLOW; undefined to leave the field out. */
function capped(value: string, cap: number, at: string, rule: string = at): string | undefined {
  if (value.length <= cap) return value;
  switch (OVERFLOW[rule.replace(/\[\d+\]/g, "[]")]) {
    case "cut":
      return cutText(value, cap);
    case "subtags":
      return cutSubtags(value, cap);
    case "drop":
      return undefined;
    default:
      throw new WirePayloadError(at, `is over its cap of ${cap} characters`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A map kept to its rules: values left undefined are left out, and a string over the cap is cut by
 * OVERFLOW. Throws WirePayloadError on a key the pattern refuses (such as a reserved am_ one), more
 * keys than the cap, or a value of another type (a nested object, an array, null, or a number that
 * isn't finite, which JSON can't carry), since leaving any of them out would change what the site
 * sent without telling it.
 */
function shapeMap(input: unknown, rules: MapShape, path: string): Record<string, unknown> {
  if (!isRecord(input)) throw new WirePayloadError(path, "is not a flat object");
  const keyPattern = rules.keyPattern === undefined ? undefined : new RegExp(rules.keyPattern, "u");
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const key of Object.keys(input)) {
    const value = input[key];
    if (value === undefined) continue;
    if (keyPattern !== undefined && !keyPattern.test(key)) {
      throw new WirePayloadError(`${path}.${key}`, "is a reserved or empty key");
    }
    if (rules.maxProperties !== undefined && ++count > rules.maxProperties) {
      throw new WirePayloadError(path, `has more than ${rules.maxProperties} keys`);
    }
    if (typeof value === "string" && rules.values.includes("string")) {
      const kept = rules.maxLength === undefined ? value : capped(value, rules.maxLength, `${path}.${key}`, `${path}.*`);
      if (kept !== undefined) out[key] = kept;
    } else if (
      typeof value === "number" &&
      (rules.values.includes("number") ? Number.isFinite(value) : rules.values.includes("integer") && Number.isInteger(value))
    ) {
      out[key] = value;
    } else if (typeof value === "boolean" && rules.values.includes("boolean")) {
      out[key] = value;
    } else {
      throw new WirePayloadError(`${path}.${key}`, `is not one of ${rules.values.join(", ")}`);
    }
  }
  return out;
}

/**
 * Copies the listed fields that are set, drops empty optional strings, keeps strings to their caps
 * by OVERFLOW, shapes nested objects and arrays' items the same way and maps by their rules, and
 * leaves out an optional object, array or map that ends up empty. Anything not in a list is left
 * out. Throws WirePayloadError when a required field is missing or an empty string, so the result
 * has every field its type requires, when an identifier is over its cap, when an array has more
 * items than its cap (cutting an order's lines would change the order), or when a map breaks a
 * rule (shapeMap).
 */
function shape<T extends object>(input: T, spec: Shape, path: string): T {
  const source = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of spec.fields) {
    const value = source[field];
    const required = spec.required.includes(field);
    if (value === undefined || value === "") {
      if (required) throw new WirePayloadError(`${path}.${field}`);
      continue;
    }
    const nested = spec.nested[field];
    if (nested !== undefined && typeof value === "object" && value !== null) {
      const inner = shape(value, nested, `${path}.${field}`);
      if (required || Object.keys(inner).length > 0) out[field] = inner;
      continue;
    }
    const items = spec.items[field];
    if (items !== undefined && Array.isArray(value)) {
      const cap = spec.maxItems[field];
      if (cap !== undefined && value.length > cap) {
        throw new WirePayloadError(`${path}.${field}`, `has more than ${cap} items`);
      }
      const inner = value.map((item: unknown, index) => {
        const at = `${path}.${field}[${index}]`;
        if (!isRecord(item)) throw new WirePayloadError(at, "is not an object");
        return shape(item, items, at);
      });
      if (required || inner.length > 0) out[field] = inner;
      continue;
    }
    const map = spec.maps[field];
    if (map !== undefined) {
      const inner = shapeMap(value, map, `${path}.${field}`);
      if (required || Object.keys(inner).length > 0) out[field] = inner;
      continue;
    }
    const cap = spec.maxLength[field];
    if (typeof value !== "string" || cap === undefined) {
      out[field] = value;
      continue;
    }
    const kept = capped(value, cap, `${path}.${field}`);
    if (kept !== undefined) out[field] = kept;
  }
  // Every field out holds came from input, a capped string still a string, and every required one
  // was checked above (only an optional one is ever dropped by its cap): out is input narrowed to
  // the listed fields.
  return out as T;
}

/**
 * Builds an event: a purchase when the input carries a purchase, which then needs type purchase,
 * and any other event otherwise. Throws WirePayloadError when a required field is missing or empty,
 * or a value breaks a rule the tag can't keep for it (shape).
 */
export function buildEvent(input: EventInput, eventId: string = uuidv7()): WireEvent {
  if ("purchase" in input && input.purchase !== undefined) {
    if (input.type !== "purchase") throw new WirePayloadError("event.type", 'is not "purchase" on an event with a purchase');
    const event: PurchaseEvent = { ...input, schema_version: SCHEMA_VERSION, event_id: eventId };
    return shape(event, PURCHASE_EVENT_SHAPE, "event");
  }
  const event: TrackedEvent = { ...input, schema_version: SCHEMA_VERSION, event_id: eventId };
  return shape(event, TRACKED_EVENT_SHAPE, "event");
}

/**
 * Keeps a ping to the schema's frozen field list; scrubbing the URL to its path is the caller's.
 * Throws WirePayloadError when a required field is missing or empty.
 */
export function buildPing(input: PingInput, eventId: string = uuidv7()): WirePing {
  const ping: WirePing = { ...input, schema_version: SCHEMA_VERSION, event_id: eventId };
  return shape(ping, WIRE_PING_SHAPE, "ping");
}
