// The payload builder: it shapes what the tag sends by the wire schema's generated field lists and
// length caps (src/wire/generated.ts), so a payload carries exactly the fields the schema allows.
import {
  SCHEMA_VERSION,
  WIRE_EVENT_FIELDS,
  WIRE_EVENT_MAX_LENGTH,
  WIRE_PING_FIELDS,
  WIRE_PING_MAX_LENGTH,
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
 * Copies the listed fields that are set, drops empty strings and cuts strings to their caps.
 * Anything not in the list is left out.
 */
function shape(
  input: object,
  fields: readonly string[],
  caps: Readonly<Record<string, number>>,
): Record<string, unknown> {
  const source = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = source[field];
    if (value === undefined || value === "") continue;
    const cap = caps[field];
    out[field] = typeof value === "string" && cap !== undefined ? value.slice(0, cap) : value;
  }
  return out;
}

export function buildEvent(input: EventInput, eventId: string = uuidv7()): WireEvent {
  return {
    ...shape(input, WIRE_EVENT_FIELDS, WIRE_EVENT_MAX_LENGTH),
    schema_version: SCHEMA_VERSION,
    event_id: eventId,
  } as WireEvent;
}

/** Keeps a ping to the schema's frozen field list; scrubbing the URL to its path is the caller's. */
export function buildPing(input: PingInput, eventId: string = uuidv7()): WirePing {
  return {
    ...shape(input, WIRE_PING_FIELDS, WIRE_PING_MAX_LENGTH),
    schema_version: SCHEMA_VERSION,
    event_id: eventId,
  } as WirePing;
}
