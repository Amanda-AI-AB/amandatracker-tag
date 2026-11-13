import { describe, expect, it } from "vitest";
import { WIRE_EVENT_SHAPE, WIRE_PING_SHAPE } from "../src/wire/generated";
import {
  buildEvent,
  buildPing,
  cutSubtags,
  cutText,
  OVERFLOW,
  uuidv7,
  WirePayloadError,
  type EventInput,
  type Shape,
  type PingInput,
} from "../src/wire/payload";
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

  it("never cuts a surrogate pair in two, so no lone surrogate reaches the collector", () => {
    const event = buildEvent({ ...eventInput(), page_title: `${"a".repeat(511)}😀` });
    expect(event.page_title).toBe("a".repeat(511));
    const whole = buildEvent({ ...eventInput(), page_title: `${"a".repeat(510)}😀b` });
    expect(whole.page_title).toBe(`${"a".repeat(510)}😀`);
  });

  it("cuts an over-long language on its last whole subtag, so it still matches its pattern", () => {
    const event = buildEvent({ ...eventInput(), language: "en-abcdefgh-abcdefgh-abcdefgh-abcd-ef" });
    expect(event.language).toBe("en-abcdefgh-abcdefgh-abcdefgh-abcd");
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
  });

  it("leaves out a language whose first subtag alone is over the cap", () => {
    const event = buildEvent({ ...eventInput(), language: "a".repeat(36) });
    expect(event).not.toHaveProperty("language");
  });

  it.each(["site_id", "type", "tag_version"] as const)(
    "throws when the identifier %s is over its cap, rather than send it as another one",
    (field) => {
      expect(() => buildEvent({ ...eventInput(), [field]: "x".repeat(65) })).toThrow(
        new WirePayloadError(`event.${field}`, "is over its cap of 64 characters"),
      );
      expect(buildEvent({ ...eventInput(), [field]: field === "tag_version" ? `1.0.0-${"x".repeat(58)}` : "x".repeat(64) })[field]).toHaveLength(64);
    },
  );
});

describe("cutText", () => {
  it("backs off one unit when the cut ends on a high surrogate", () => {
    expect(cutText("ab😀", 3)).toBe("ab");
    expect(cutText("ab😀", 4)).toBe("ab😀");
    expect(cutText("😀", 0)).toBe("");
  });
});

describe("cutSubtags", () => {
  it.each([
    ["en-US", 5, "en-US"],
    ["en-US", 4, "en"],
    ["en-abcd-ef", 9, "en-abcd"],
    ["zh-Hant-x-abc", 11, "zh-Hant"],
    ["abcdefgh", 7, undefined],
  ] as const)("cuts %s to %i as %s", (tag, cap, cut) => {
    expect(cutSubtags(tag, cap)).toBe(cut);
  });
});

describe("OVERFLOW", () => {
  const shapes: Record<string, Shape> = { event: WIRE_EVENT_SHAPE, ping: WIRE_PING_SHAPE };

  function capped(prefix: string, spec: Shape): { at: string; required: boolean }[] {
    return [
      ...Object.keys(spec.maxLength).map((field) => ({ at: `${prefix}.${field}`, required: spec.required.includes(field) })),
      ...Object.entries(spec.nested).flatMap(([field, inner]) => capped(`${prefix}.${field}`, inner)),
    ];
  }
  const all = Object.entries(shapes).flatMap(([prefix, spec]) => capped(prefix, spec));

  it("names only capped fields", () => {
    for (const at of Object.keys(OVERFLOW)) expect(all.map((field) => field.at)).toContain(at);
  });

  it("can leave out only optional fields", () => {
    for (const { at, required } of all) {
      if (required) expect([undefined, "cut"]).toContain(OVERFLOW[at]);
    }
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

  it("cuts an over-long path and leaves out an over-long referrer_host", () => {
    const ping = buildPing({ ...pingInput(), path: `/${"p".repeat(2046)}😀`, referrer_host: `${"h".repeat(250)}.example` });
    expect(ping.path).toBe(`/${"p".repeat(2046)}`);
    expect(ping).not.toHaveProperty("referrer_host");
    expect(validate(ping), JSON.stringify(validate.errors)).toBe(true);
  });

  it("throws when site_id is over its cap", () => {
    expect(() => buildPing({ ...pingInput(), site_id: "s".repeat(65) })).toThrow(
      "wire payload: ping.site_id is over its cap of 64 characters",
    );
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
