import { describe, expect, it } from "vitest";
import { buildEvent, buildPing, uuidv7, WirePayloadError, type EventInput, type PingInput } from "../src/wire/payload";
import { EVENT, PING, validator } from "./wire-validator";

const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function eventInput(): EventInput {
  const { schema_version, event_id, ...input } = EVENT;
  return { ...input, consent: { ...input.consent }, props: { ...input.props } };
}

function pingInput(): PingInput {
  const { schema_version, event_id, ...input } = PING;
  return { ...input, utm: { ...input.utm } };
}

describe("uuidv7", () => {
  it("is a version-7 UUID with the time in its first 48 bits", () => {
    const now = 1_731_400_000_000;
    const id = uuidv7(now);
    expect(id).toMatch(UUID7);
    expect(parseInt(id.slice(0, 8) + id.slice(9, 13), 16)).toBe(now);
  });

  it("sets the version and variant whatever the random bytes", () => {
    expect(uuidv7(0, new Uint8Array(10).fill(0xff))).toBe("00000000-0000-7fff-bfff-ffffffffffff");
    expect(uuidv7(0, new Uint8Array(10))).toBe("00000000-0000-7000-8000-000000000000");
  });

  it("differs between calls", () => {
    expect(uuidv7()).not.toBe(uuidv7());
  });

  it("refuses too few random bytes", () => {
    expect(() => uuidv7(0, new Uint8Array(9))).toThrow("10 random bytes");
  });
});

describe("buildEvent", () => {
  const validate = validator("event.json");

  it("builds a valid event with the schema version and a fresh UUIDv7", () => {
    const event = buildEvent(eventInput());
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
    expect(event.schema_version).toBe(1);
    expect(event.event_id).toMatch(UUID7);
  });

  it("leaves out fields the schema doesn't list, and empty optional strings", () => {
    const input = { ...eventInput(), referrer: "", ip: "203.0.113.7" } as EventInput;
    const event = buildEvent(input, EVENT.event_id);
    expect(event).not.toHaveProperty("ip");
    expect(event).not.toHaveProperty("referrer");
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each(["url", "site_id", "type", "tag_version", "visitor_id", "session_id"] as const)(
    "throws when the required %s is empty or missing, rather than build an event the collector drops",
    (field) => {
      expect(() => buildEvent({ ...eventInput(), [field]: "" })).toThrow(new WirePayloadError(`event.${field}`));
      const missing: Partial<EventInput> = eventInput();
      delete missing[field];
      expect(() => buildEvent(missing as EventInput)).toThrow(WirePayloadError);
    },
  );

  it("throws when consent is missing, or a required field in it is", () => {
    const missing: Partial<EventInput> = eventInput();
    delete missing.consent;
    expect(() => buildEvent(missing as EventInput)).toThrow(new WirePayloadError("event.consent"));
    const consent = { ads: "denied" } as EventInput["consent"];
    expect(() => buildEvent({ ...eventInput(), consent })).toThrow(new WirePayloadError("event.consent.analytics"));
  });

  it("names the field in its error", () => {
    expect(() => buildEvent({ ...eventInput(), site_id: "" })).toThrow(
      "wire payload: event.site_id is required and is missing or empty",
    );
  });

  it("cuts strings to the schema's caps", () => {
    const event = buildEvent({ ...eventInput(), url: `https://a.example/${"x".repeat(5000)}`, page_title: "t".repeat(600) });
    expect(event.url).toHaveLength(2048);
    expect(event.page_title).toHaveLength(512);
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe("buildPing", () => {
  const validate = validator("ping.json");

  it("builds a valid ping", () => {
    const ping = buildPing(pingInput());
    expect(validate(ping), JSON.stringify(validate.errors)).toBe(true);
    expect(ping.event_id).toMatch(UUID7);
  });

  it("carries exactly the frozen field list, whatever it is given", () => {
    const input = {
      ...pingInput(),
      visitor_id: EVENT.visitor_id,
      session_id: EVENT.session_id,
      seq: 4,
      gclid: "abc",
      order_id: "1001",
      revenue: 99,
      language: "sv",
    } as PingInput;
    const ping = buildPing(input);
    expect(Object.keys(ping).sort()).toEqual(
      ["event_id", "path", "referrer_host", "schema_version", "site_id", "type", "utm"],
    );
    expect(Object.keys(ping.utm!).sort()).toEqual(["campaign", "medium", "source"]);
    expect(validate(ping), JSON.stringify(validate.errors)).toBe(true);
  });

  it("keeps utm to its field list and caps, so no click id leaves and a long value can't void the ping", () => {
    const input = pingInput();
    const utm = { ...input.utm, campaign: "c".repeat(300), gclid: "abc", fbclid: "def" };
    const ping = buildPing({ ...input, utm } as PingInput);
    expect(ping.utm).not.toHaveProperty("gclid");
    expect(ping.utm).not.toHaveProperty("fbclid");
    expect(ping.utm!.campaign).toHaveLength(256);
    expect(validate(ping), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each(["site_id", "type", "path"] as const)("throws when the required %s is empty or missing", (field) => {
    expect(() => buildPing({ ...pingInput(), [field]: "" })).toThrow(new WirePayloadError(`ping.${field}`));
    const missing: Partial<PingInput> = pingInput();
    delete missing[field];
    expect(() => buildPing(missing as PingInput)).toThrow(WirePayloadError);
  });

  it("leaves out empty optional strings", () => {
    const ping = buildPing({ ...pingInput(), referrer_host: "" });
    expect(ping).not.toHaveProperty("referrer_host");
    expect(validate(ping), JSON.stringify(validate.errors)).toBe(true);
  });

  it("does not hand back the caller's utm object", () => {
    const input = pingInput();
    expect(buildPing(input).utm).not.toBe(input.utm);
  });

  it("leaves out utm when nothing in it is on the field list", () => {
    const ping = buildPing({ ...pingInput(), utm: { source: "", gclid: "abc" } } as PingInput);
    expect(ping).not.toHaveProperty("utm");
    expect(validate(ping), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe("buildEvent nested consent", () => {
  const validate = validator("event.json");

  it("keeps consent to its field list", () => {
    const input = eventInput();
    const event = buildEvent({ ...input, consent: { ...input.consent, functional: "granted" } } as EventInput);
    expect(Object.keys(event.consent).sort()).toEqual(["ads", "analytics"]);
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
  });
});
