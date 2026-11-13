// The payload builder: it shapes what the tag sends by the wire schema's generated field lists,
// types and rules (src/wire/generated.ts), so a payload carries exactly the fields the schema
// allows, each with a value it accepts, or isn't built at all.
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

/** The span a ping's event_id rounds its time down to: one hour. */
export const PING_ID_PERIOD_MS = 3_600_000;

/**
 * A ping's event_id: a UUIDv7 whose time is the start of the hour, not the millisecond, so the ID
 * doesn't carry the browser's clock (and its skew, a stable device fingerprint) that the ping leaves
 * client_ts out to hide. Rounding down keeps it a valid v7 in the right UTC month, and moves its
 * time at most an hour earlier, inside the collector's 24 h window (AAI-835).
 */
export function pingId(nowMs: number = Date.now(), random?: Uint8Array): string {
  return uuidv7(Math.floor(nowMs / PING_ID_PERIOD_MS) * PING_ID_PERIOD_MS, random);
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

/** A field's JSON type, as generated. */
export type JsonType = "string" | "number" | "integer" | "boolean" | "object" | "array";

/**
 * An object's shape, as generated: its field list, its required fields, its fields' JSON types,
 * const or enum values, numbers' minimums and strings' patterns, its strings' and arrays' caps, its
 * nested objects' shapes, its arrays' item shapes and its maps' rules.
 */
export interface Shape {
  readonly fields: readonly string[];
  readonly required: readonly string[];
  readonly types: Readonly<Record<string, JsonType>>;
  readonly values: Readonly<Record<string, readonly (string | number | boolean)[]>>;
  readonly minimum: Readonly<Record<string, number>>;
  readonly pattern: Readonly<Record<string, string>>;
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
 * an optional structured value a cut would turn into another one, left out; it is left out too when
 * it breaks its pattern (a full referrer URL given as the referrer's host), since sending what it
 * holds instead could carry PII. A capped field not listed here is an identifier, which a cut would
 * silently re-target: the payload is refused. An array's items are listed as `[]`, and a map's
 * string values as `.*`.
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

/**
 * Strings upper-cased before their pattern is checked, by path: an ISO 4217 code means the same in
 * either case, and site JS often gives it in lower case ("sek").
 */
export const UPPER_CASE: readonly string[] = ["event.purchase.currency"];

/**
 * URL parts cut off before a string is capped, by path: a string is cut at the first of these
 * characters it holds. A ping's path loses its query and fragment, so neither an email address nor
 * a reset token leaves a browser whose visitor declined; an event's URLs lose their fragment, which
 * can hold an OAuth implicit flow's access token and never reaches a server otherwise.
 */
export const STRIP_FROM: Readonly<Record<string, string>> = {
  "event.url": "#",
  "event.referrer": "#",
  "ping.path": "?#",
};

/** value up to the first of the characters in from it holds, or whole when it holds none. */
export function stripFrom(value: string, from: string): string {
  let end = value.length;
  for (const char of from) {
    const at = value.indexOf(char);
    if (at !== -1 && at < end) end = at;
  }
  return value.slice(0, end);
}

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

const PATTERNS = new Map<string, RegExp>();

/**
 * A schema pattern compiled once and kept, so building an event doesn't recompile its patterns on
 * the visitor's main thread. The patterns are the generated shapes' own, a fixed few.
 */
export function compiledPattern(pattern: string): RegExp {
  let compiled = PATTERNS.get(pattern);
  if (compiled === undefined) {
    compiled = new RegExp(pattern, "u");
    PATTERNS.set(pattern, compiled);
  }
  return compiled;
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
  const keyPattern = rules.keyPattern === undefined ? undefined : compiledPattern(rules.keyPattern);
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

const NOUN: Readonly<Record<JsonType, string>> = {
  string: "a string",
  number: "a finite number",
  integer: "an integer",
  boolean: "a boolean",
  object: "an object",
  array: "an array",
};

/** Whether value is of the JSON type: a number finite, and an integer a whole one. */
function isType(value: unknown, type: JsonType): boolean {
  switch (type) {
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    default:
      return typeof value === type;
  }
}

/**
 * One field's value kept to its rules: a string upper-cased by UPPER_CASE, cut by STRIP_FROM, kept
 * to its cap by OVERFLOW and checked against its pattern; a number checked against its minimum; a
 * const or enum checked against its values; a nested object, an array's items and a map shaped by
 * theirs. Undefined to leave the field out: an optional string OVERFLOW drops (over its cap or off
 * its pattern) or STRIP_FROM empties, or an optional object, array or map that ends up empty. Throws WirePayloadError on a value of another type (a revenue given as
 * "249.90", NaN, items given as an object), one that breaks a rule, an array over its item cap
 * (cutting an order's lines would change the order), or an object or array the shape has no rules
 * for, since sending any of them would have the collector refuse the event.
 */
function shapeField(value: unknown, field: string, spec: Shape, at: string, required: boolean): unknown {
  const type = spec.types[field];
  if (type === undefined) throw new WirePayloadError(at, "has no type in its shape");
  if (!isType(value, type)) throw new WirePayloadError(at, `is not ${NOUN[type]}`);
  if (type === "object") {
    const nested = spec.nested[field];
    const map = spec.maps[field];
    let inner: Record<string, unknown>;
    if (nested !== undefined) inner = shape(value as Record<string, unknown>, nested, at);
    else if (map !== undefined) inner = shapeMap(value, map, at);
    else throw new WirePayloadError(at, "has no shape the tag can check");
    return required || Object.keys(inner).length > 0 ? inner : undefined;
  }
  if (type === "array") {
    const list = value as unknown[];
    const items = spec.items[field];
    if (items === undefined) throw new WirePayloadError(at, "has no item shape the tag can check");
    const cap = spec.maxItems[field];
    if (cap !== undefined && list.length > cap) throw new WirePayloadError(at, `has more than ${cap} items`);
    const inner = list.map((item, index) => {
      const itemAt = `${at}[${index}]`;
      if (!isRecord(item)) throw new WirePayloadError(itemAt, "is not an object");
      return shape(item, items, itemAt);
    });
    return required || inner.length > 0 ? inner : undefined;
  }
  let kept = value as string | number | boolean;
  if (typeof kept === "string") {
    const rule = at.replace(/\[\d+\]/g, "[]");
    if (UPPER_CASE.includes(rule)) kept = kept.toUpperCase();
    const strip = STRIP_FROM[rule];
    if (strip !== undefined) {
      kept = stripFrom(kept, strip);
      if (kept === "") {
        if (required) throw new WirePayloadError(at);
        return undefined;
      }
    }
    const cap = spec.maxLength[field];
    if (cap !== undefined) {
      const cut = capped(kept, cap, at, rule);
      if (cut === undefined) return undefined;
      kept = cut;
    }
    const pattern = spec.pattern[field];
    if (pattern !== undefined && !compiledPattern(pattern).test(kept)) {
      if (OVERFLOW[rule] === "drop") return undefined;
      throw new WirePayloadError(at, `does not match ${pattern}`);
    }
  }
  const minimum = spec.minimum[field];
  if (typeof kept === "number" && minimum !== undefined && kept < minimum) {
    throw new WirePayloadError(at, `is under its minimum of ${minimum}`);
  }
  const values = spec.values[field];
  if (values !== undefined && !values.includes(kept)) {
    throw new WirePayloadError(at, `is not one of ${values.join(", ")}`);
  }
  return kept;
}

/**
 * Copies the listed fields that are set, each kept to its rules (shapeField), and drops optional
 * fields that are null or empty strings. Anything not in a list is left out. Throws
 * WirePayloadError when a required field is missing, null or an empty string, so the result has
 * every field its type requires, or when a value can't be kept to its rules (shapeField, capped,
 * shapeMap). Null counts as missing because untyped callers (the cfg JSON, an adapter's global,
 * the command queue) give it for "not set", and the schema allows null nowhere (AAI-933).
 */
function shape<T extends object>(input: T, spec: Shape, path: string): T {
  const source = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of spec.fields) {
    const value = source[field];
    const required = spec.required.includes(field);
    if (value === undefined || value === null || value === "") {
      if (required) throw new WirePayloadError(`${path}.${field}`);
      continue;
    }
    const kept = shapeField(value, field, spec, `${path}.${field}`, required);
    if (kept !== undefined) out[field] = kept;
  }
  // Every field out holds came from input, of its schema type and kept to its rules, and every
  // required one was checked above (only an optional one is ever dropped by its cap): out is input
  // narrowed to the listed fields.
  return out as T;
}

/**
 * Builds an event: a purchase when the input carries a purchase, which then needs type purchase,
 * and any other event otherwise, whose type is never purchase. Throws WirePayloadError when a
 * required field is missing or empty (an event of type purchase without its purchase included), the
 * purchase isn't an object (null included), or a value breaks a rule the tag can't keep for it
 * (shape).
 */
export function buildEvent(input: EventInput, eventId: string = uuidv7()): WireEvent {
  if ("purchase" in input && input.purchase !== undefined) {
    if (!isRecord(input.purchase)) throw new WirePayloadError("event.purchase", "is not an object");
    if (input.type !== "purchase") throw new WirePayloadError("event.type", 'is not "purchase" on an event with a purchase');
    const event: PurchaseEvent = { ...input, schema_version: SCHEMA_VERSION, event_id: eventId };
    return shape(event, PURCHASE_EVENT_SHAPE, "event");
  }
  if (input.type === "purchase") throw new WirePayloadError("event.purchase");
  const event: TrackedEvent = { ...input, schema_version: SCHEMA_VERSION, event_id: eventId };
  return shape(event, TRACKED_EVENT_SHAPE, "event");
}

/**
 * Keeps a ping to the schema's frozen field list, and scrubs it whatever the caller passes: the path
 * loses its query string and fragment (STRIP_FROM), and a referrer_host that isn't a bare hostname,
 * such as a full referrer URL, is left out (OVERFLOW's drop). Throws WirePayloadError when a
 * required field is missing or empty (a path that was only a query), or a value breaks a rule the
 * tag can't keep for it (a path that doesn't start with "/", such as a whole URL). Its event_id's
 * time is only the hour (pingId).
 */
export function buildPing(input: PingInput, eventId: string = pingId()): WirePing {
  const ping: WirePing = { ...input, schema_version: SCHEMA_VERSION, event_id: eventId };
  return shape(ping, WIRE_PING_SHAPE, "ping");
}
