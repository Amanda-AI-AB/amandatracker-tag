import { describe, expect, it } from "vitest";
import { EVENT, loadSchemas, PING, UUID7, validator } from "./wire-validator";

describe("wire schema v1: event", () => {
  const validate = validator("event.json");

  it("accepts a full event", () => {
    expect(validate(EVENT), JSON.stringify(validate.errors)).toBe(true);
  });

  it("accepts an event without its optional fields", () => {
    const { referrer, page_title, language, props, ...minimal } = EVENT;
    expect(validate(minimal), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each(["visitor_id", "session_id", "consent", "event_id", "site_id", "client_ts", "url"])(
    "requires %s",
    (field) => {
      const event: Record<string, unknown> = { ...EVENT };
      delete event[field];
      expect(validate(event)).toBe(false);
    },
  );

  it("rejects a field the schema doesn't list", () => {
    expect(validate({ ...EVENT, ip: "203.0.113.7" })).toBe(false);
  });

  it("rejects an event id that isn't a UUIDv7", () => {
    expect(validate({ ...EVENT, event_id: "01934f6c-8d2a-4b3c-9d4e-5f6a7b8c9d0e" })).toBe(false);
    expect(validate({ ...EVENT, event_id: UUID7.toUpperCase() })).toBe(false);
  });

  it("accepts the four consent states and nothing else", () => {
    for (const state of ["granted", "denied", "unknown", "no_cmp"]) {
      expect(validate({ ...EVENT, consent: { analytics: state, ads: state } })).toBe(true);
    }
    expect(validate({ ...EVENT, consent: { analytics: "yes", ads: "denied" } })).toBe(false);
    expect(validate({ ...EVENT, consent: { analytics: "granted" } })).toBe(false);
    expect(validate({ ...EVENT, consent: { ...EVENT.consent, functional: "granted" } })).toBe(false);
  });

  it("rejects another schema version, a non-semver tag version and a fractional timestamp", () => {
    expect(validate({ ...EVENT, schema_version: 2 })).toBe(false);
    expect(validate({ ...EVENT, tag_version: "v1" })).toBe(false);
    expect(validate({ ...EVENT, client_ts: 1.5 })).toBe(false);
  });

  it("caps the URL's length", () => {
    expect(validate({ ...EVENT, url: `https://a.example/${"x".repeat(2048)}` })).toBe(false);
  });
});

describe("wire schema v1: anonymous ping", () => {
  const validate = validator("ping.json");

  it("accepts a ping", () => {
    expect(validate(PING), JSON.stringify(validate.errors)).toBe(true);
  });

  it("has exactly the frozen field list", () => {
    const ping = loadSchemas()["ping.json"]!;
    expect(Object.keys(ping.properties as object)).toEqual([
      "schema_version",
      "event_id",
      "site_id",
      "type",
      "path",
      "referrer_host",
      "utm",
    ]);
    expect(ping.additionalProperties).toBe(false);
  });

  it.each([
    ["visitor_id", EVENT.visitor_id],
    ["session_id", EVENT.session_id],
    ["seq", 3],
    ["gclid", "abc"],
    ["click_ids", { gclid: "abc" }],
    ["order_id", "1001"],
    ["revenue", 99],
    ["language", "sv"],
    ["url", EVENT.url],
    ["props", {}],
  ])("rejects %s", (field, value) => {
    expect(validate({ ...PING, [field]: value })).toBe(false);
  });

  it("rejects a path with a query string or fragment, and a referrer that isn't a hostname", () => {
    expect(validate({ ...PING, path: "/products?email=a@b.example" })).toBe(false);
    expect(validate({ ...PING, path: "/products#top" })).toBe(false);
    expect(validate({ ...PING, referrer_host: "https://search.example/q" })).toBe(false);
  });

  it("accepts only the five UTM parameters", () => {
    expect(validate({ ...PING, utm: { source: "a", medium: "b", campaign: "c", term: "d", content: "e" } })).toBe(true);
    expect(validate({ ...PING, utm: { id: "x" } })).toBe(false);
  });
});

describe("wire schema v1: Pub/Sub message", () => {
  const validate = validator("pubsub-message.json");
  const message = {
    schema_version: 1,
    received_at: 1_731_400_000_123,
    region: "europe-west1",
    country: "SE",
    device_class: "mobile",
  };

  it("carries an event or a ping", () => {
    expect(validate({ ...message, event: EVENT }), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...message, event: PING }), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects a payload that is neither, such as a ping with a visitor id", () => {
    expect(validate({ ...message, event: { ...PING, visitor_id: EVENT.visitor_id } })).toBe(false);
  });

  it("never carries the IP address", () => {
    expect(validate({ ...message, event: PING, ip: "203.0.113.7" })).toBe(false);
  });

  it("allows an unknown country, and checks its shape and the device class", () => {
    const { country, ...noCountry } = message;
    expect(validate({ ...noCountry, event: PING })).toBe(true);
    expect(validate({ ...message, country: "se", event: PING })).toBe(false);
    expect(validate({ ...message, device_class: "smartwatch", event: PING })).toBe(false);
  });
});

describe("wire schema v1: every object is closed", () => {
  function openObjects(node: unknown, path: string, found: string[]): string[] {
    if (node && typeof node === "object") {
      const record = node as Record<string, unknown>;
      if (record.type === "object" && record.properties && record.additionalProperties !== false) found.push(path);
      for (const [key, value] of Object.entries(record)) openObjects(value, `${path}/${key}`, found);
    }
    return found;
  }

  it("sets additionalProperties: false on every object with properties", () => {
    for (const [file, schema] of Object.entries(loadSchemas())) {
      expect(openObjects(schema, file, [])).toEqual([]);
    }
  });
});
