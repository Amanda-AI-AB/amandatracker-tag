// The payload builder: it shapes what the tag sends by the wire schema's generated field lists and
// length caps (src/wire/generated.ts), so a payload carries exactly the fields the schema allows.
import {
  SCHEMA_VERSION,
  WIRE_EVENT_SHAPE,
  WIRE_PING_SHAPE,
  type WireEvent,
  type WirePing,
} from "./generated";

export type EventInput = Omit<WireEvent, "schema_version" | "event_id">;
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
 * An object's shape, as generated: its field list, its required fields, its strings' caps and its
 * nested objects' shapes.
 */
export interface Shape {
  readonly fields: readonly string[];
  readonly required: readonly string[];
  readonly maxLength: Readonly<Record<string, number>>;
  readonly nested: Readonly<Record<string, Shape>>;
}

/**
 * A payload the tag can't build: a field the schema requires is missing or empty, or an identifier
 * is over its cap.
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
 * listed here is an identifier, which a cut would silently re-target: the payload is refused.
 */
export const OVERFLOW: Readonly<Record<string, "cut" | "subtags" | "drop">> = {
  "event.url": "cut",
  "event.referrer": "cut",
  "event.page_title": "cut",
  "event.language": "subtags",
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
function capped(value: string, cap: number, at: string): string | undefined {
  if (value.length <= cap) return value;
  switch (OVERFLOW[at]) {
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

/**
 * Copies the listed fields that are set, drops empty optional strings, keeps strings to their caps
 * by OVERFLOW, and shapes nested objects the same way, leaving out an optional one that ends up
 * empty. Anything not in a list is left out. Throws WirePayloadError when a required field is
 * missing or an empty string, so the result has every field its type requires, or when an
 * identifier is over its cap.
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

/** Builds an event; throws WirePayloadError when a required field is missing or empty. */
export function buildEvent(input: EventInput, eventId: string = uuidv7()): WireEvent {
  const event: WireEvent = { ...input, schema_version: SCHEMA_VERSION, event_id: eventId };
  return shape(event, WIRE_EVENT_SHAPE, "event");
}

/**
 * Keeps a ping to the schema's frozen field list; scrubbing the URL to its path is the caller's.
 * Throws WirePayloadError when a required field is missing or empty.
 */
export function buildPing(input: PingInput, eventId: string = uuidv7()): WirePing {
  const ping: WirePing = { ...input, schema_version: SCHEMA_VERSION, event_id: eventId };
  return shape(ping, WIRE_PING_SHAPE, "ping");
}
