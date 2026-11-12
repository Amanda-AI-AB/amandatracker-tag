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
interface Shape {
  readonly fields: readonly string[];
  readonly required: readonly string[];
  readonly maxLength: Readonly<Record<string, number>>;
  readonly nested: Readonly<Record<string, Shape>>;
}

/** A payload the tag can't build: a field the schema requires is missing or empty. */
export class WirePayloadError extends Error {
  constructor(readonly field: string) {
    super(`wire payload: ${field} is required and is missing or empty`);
    this.name = "WirePayloadError";
  }
}

/**
 * Copies the listed fields that are set, drops empty optional strings and cuts strings to their
 * caps, and shapes nested objects the same way, leaving out an optional one that ends up empty.
 * Anything not in a list is left out. Throws WirePayloadError when a required field is missing or
 * an empty string, so the result has every field its type requires.
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
    out[field] = typeof value === "string" && cap !== undefined ? value.slice(0, cap) : value;
  }
  // Every field out holds came from input, a capped string still a string, and every required one
  // was checked above: out is input narrowed to the listed fields.
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
