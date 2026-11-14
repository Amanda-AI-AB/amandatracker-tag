import { describe, expect, it } from "vitest";
import { EVENT, loadSchemas, PAGE_EXIT, PING, PURCHASE, UUID7, validator } from "./wire-validator";

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

  it("accepts the consent snapshot's source, gpc, manual, gcm, tcf, cookiebot, onetrust or usercentrics, and no other", () => {
    for (const source of ["gpc", "manual", "gcm", "tcf", "cookiebot", "onetrust", "usercentrics"]) {
      expect(validate({ ...EVENT, consent: { ...EVENT.consent, source } })).toBe(true);
    }
    expect(validate({ ...EVENT, consent: { ...EVENT.consent, source: "unlisted-cmp" } })).toBe(false);
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

describe("wire schema v1: props (01 §4)", () => {
  const validate = validator("event.json");
  const props = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, i]));

  it("accepts strings, numbers and booleans", () => {
    const event = { ...EVENT, props: { plan: "pro", seats: 3, price: 9.5, trial: false, note: "" } };
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each([
    ["an object", { nested: { a: 1 } }],
    ["an array", { list: [1, 2] }],
    ["null", { gone: null }],
  ])("rejects %s as a value", (_, value) => {
    expect(validate({ ...EVENT, props: value })).toBe(false);
  });

  it("takes 25 keys and rejects 26", () => {
    expect(validate({ ...EVENT, props: props(25) })).toBe(true);
    expect(validate({ ...EVENT, props: props(26) })).toBe(false);
  });

  it("takes a string of 200 characters and rejects 201", () => {
    expect(validate({ ...EVENT, props: { s: "x".repeat(200) } })).toBe(true);
    expect(validate({ ...EVENT, props: { s: "x".repeat(201) } })).toBe(false);
  });

  it.each(["am_", "am_source", "am_x_y"])("rejects the reserved key %s", (key) => {
    expect(validate({ ...EVENT, props: { [key]: "x" } })).toBe(false);
  });

  it.each(["a", "am", "amx", "AM_x", "Am_x", "x_am_", "plan", "_am_", "ämne"])("accepts the key %s", (key) => {
    expect(validate({ ...EVENT, props: { [key]: "x" } }), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects an empty key", () => {
    expect(validate({ ...EVENT, props: { "": "x" } })).toBe(false);
  });

  it("says in its description that the 8 KB total is the collector's to enforce", () => {
    const defs = loadSchemas()["event.json"]!.$defs as Record<string, { description: string }>;
    expect(defs.Props!.description).toContain("8 KB");
    expect(defs.Props!.description).toContain("AAI-65");
  });
});

describe("wire schema v1: purchase", () => {
  const validate = validator("event.json");

  it("accepts a full purchase, and one without items", () => {
    expect(validate(PURCHASE), JSON.stringify(validate.errors)).toBe(true);
    const { items, ...order } = PURCHASE.purchase;
    expect(validate({ ...PURCHASE, purchase: order }), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects a purchase on another type of event", () => {
    expect(validate({ ...PURCHASE, type: "pageview" })).toBe(false);
  });

  it("rejects an event of type purchase without a purchase, which no other event may be (AAI-921)", () => {
    const { purchase, ...rest } = PURCHASE;
    expect(validate(rest)).toBe(false);
    expect(validate({ ...EVENT, type: "purchase" })).toBe(false);
  });

  it.each(["p", "pu", "purchas", "purchased", "purchase_intent", "Purchase", "PURCHASE", "xpurchase", "purchase\n"])(
    "takes %j as the type of an ordinary event",
    (type) => {
      expect(validate({ ...EVENT, type }), JSON.stringify(validate.errors)).toBe(true);
    },
  );

  it("still takes a ping of type purchase, whose type stays any EventType", () => {
    const validatePing = validator("ping.json");
    expect(validatePing({ ...PING, type: "purchase" }), JSON.stringify(validatePing.errors)).toBe(true);
  });

  it.each(["order_id", "revenue", "currency"])("requires %s", (field) => {
    const order: Record<string, unknown> = { ...PURCHASE.purchase };
    delete order[field];
    expect(validate({ ...PURCHASE, purchase: order })).toBe(false);
  });

  it.each(["sku", "qty", "price"])("requires %s on an item", (field) => {
    const item: Record<string, unknown> = { ...PURCHASE.purchase.items[0] };
    delete item[field];
    expect(validate({ ...PURCHASE, purchase: { ...PURCHASE.purchase, items: [item] } })).toBe(false);
  });

  it.each([
    ["a lower-case currency", { currency: "sek" }],
    ["a currency that isn't three letters", { currency: "SEKR" }],
    ["a negative revenue", { revenue: -1 }],
    ["an empty order_id", { order_id: "" }],
    ["a string revenue", { revenue: "249.90" }],
    ["an empty item list", { items: [] }],
    ["51 items", { items: Array(51).fill(PURCHASE.purchase.items[1]) }],
    ["an item quantity of 0", { items: [{ sku: "a", qty: 0, price: 1 }] }],
    ["a fractional quantity", { items: [{ sku: "a", qty: 1.5, price: 1 }] }],
    ["a negative price", { items: [{ sku: "a", qty: 1, price: -1 }] }],
    ["a field on an item the schema doesn't list", { items: [{ sku: "a", qty: 1, price: 1, color: "red" }] }],
    ["a field the schema doesn't list", { coupon: "NOV10" }],
  ])("rejects %s", (_, change) => {
    expect(validate({ ...PURCHASE, purchase: { ...PURCHASE.purchase, ...change } })).toBe(false);
  });

  it("takes 50 items", () => {
    const items = Array(50).fill(PURCHASE.purchase.items[1]);
    expect(validate({ ...PURCHASE, purchase: { ...PURCHASE.purchase, items } }), JSON.stringify(validate.errors)).toBe(true);
  });

  it("gives a purchase the same envelope as every other event", () => {
    const defs = loadSchemas()["event.json"]!.$defs as Record<string, { properties: Record<string, unknown>; required: string[] }>;
    const tracked = defs.TrackedEvent!;
    const purchase = defs.PurchaseEvent!;
    const { type: trackedType, ...trackedRest } = tracked.properties;
    const { type: purchaseType, purchase: order, ...purchaseRest } = purchase.properties;
    expect(purchaseRest).toEqual(trackedRest);
    expect(purchaseType).toMatchObject({ const: "purchase" });
    expect(purchase.required).toEqual([...tracked.required, "purchase"]);
  });

  it("names each envelope field once in $defs, so that every event only refers to it", () => {
    const defs = loadSchemas()["event.json"]!.$defs as Record<string, { properties: Record<string, object> }>;
    for (const name of ["TrackedEvent", "PurchaseEvent", "PageExitEvent"]) {
      const { type, ...envelope } = defs[name]!.properties;
      for (const [key, prop] of Object.entries(envelope)) {
        expect(Object.keys(prop), `${name}.${key}`).toEqual(["$ref"]);
      }
    }
  });

  it("rides in a batch and a Pub/Sub message", () => {
    expect(validator("batch.json")({ seq: 1, e: [EVENT, PURCHASE] })).toBe(true);
    const message = { schema_version: 1, received_at: 1, region: "europe-west1", device_class: "desktop", event: PURCHASE };
    expect(validator("pubsub-message.json")(message)).toBe(true);
  });
});

describe("wire schema v1: page_exit (AAI-105)", () => {
  const validate = validator("event.json");

  it("accepts a page_exit, and one with no engagement since the previous one", () => {
    expect(validate(PAGE_EXIT), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...PAGE_EXIT, engagement_ms: 0 }), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects a page_exit without its engagement time, which no other event may be", () => {
    const { engagement_ms, ...rest } = PAGE_EXIT;
    expect(validate(rest)).toBe(false);
    expect(validate({ ...EVENT, type: "page_exit" })).toBe(false);
  });

  it("rejects an engagement time on another type of event, a purchase included", () => {
    expect(validate({ ...PAGE_EXIT, type: "pageview" })).toBe(false);
    expect(validate({ ...PURCHASE, engagement_ms: 1 })).toBe(false);
  });

  it.each([
    ["a negative", -1],
    ["a fractional", 1.5],
    ["a string", "1000"],
  ])("rejects %s engagement time", (_, engagement) => {
    expect(validate({ ...PAGE_EXIT, engagement_ms: engagement })).toBe(false);
  });

  it.each(["pa", "page", "page_", "page_exi", "page_exits", "page_exit_intent", "Page_exit", "PAGE_EXIT", "xpage_exit", "page_exit\n", "pageview", "pa_exit"])(
    "takes %j as the type of an ordinary event",
    (type) => {
      expect(validate({ ...EVENT, type }), JSON.stringify(validate.errors)).toBe(true);
    },
  );

  it("gives a page_exit the same envelope as every other event", () => {
    const defs = loadSchemas()["event.json"]!.$defs as Record<string, { properties: Record<string, unknown>; required: string[] }>;
    const tracked = defs.TrackedEvent!;
    const exit = defs.PageExitEvent!;
    const { type: trackedType, ...trackedRest } = tracked.properties;
    const { type: exitType, engagement_ms: engagement, ...exitRest } = exit.properties;
    expect(exitRest).toEqual(trackedRest);
    expect(exitType).toMatchObject({ const: "page_exit" });
    expect(exit.required).toEqual([...tracked.required, "engagement_ms"]);
  });

  it("rides in a batch and a Pub/Sub message", () => {
    expect(validator("batch.json")({ seq: 1, e: [EVENT, PAGE_EXIT] })).toBe(true);
    const message = { schema_version: 1, received_at: 1, region: "europe-west1", device_class: "desktop", event: PAGE_EXIT };
    expect(validator("pubsub-message.json")(message)).toBe(true);
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

  it("carries an event's subdivision, browser family and major, and OS family (AAI-908)", () => {
    const derived = { subdivision: "SE-AB", browser_family: "Chrome Mobile", browser_major: 131, os_family: "Android" };
    expect(validate({ ...message, ...derived, event: EVENT }), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...message, subdivision: "GB-ENG", event: EVENT })).toBe(true);
    expect(validate({ ...message, subdivision: "FR-75C", event: EVENT })).toBe(true);
  });

  it("checks the shape of the subdivision and the user-agent fields", () => {
    for (const subdivision of ["se-ab", "SE", "SE-", "SE-ABCD", "SEAB"]) {
      expect(validate({ ...message, subdivision, event: EVENT }), subdivision).toBe(false);
    }
    expect(validate({ ...message, browser_family: "", event: EVENT })).toBe(false);
    expect(validate({ ...message, browser_family: "x".repeat(65), event: EVENT })).toBe(false);
    expect(validate({ ...message, os_family: "", event: EVENT })).toBe(false);
    expect(validate({ ...message, os_family: "x".repeat(65), event: EVENT })).toBe(false);
    expect(validate({ ...message, browser_major: -1, event: EVENT })).toBe(false);
    expect(validate({ ...message, browser_major: 131.5, event: EVENT })).toBe(false);
    expect(validate({ ...message, browser_major: "131", event: EVENT })).toBe(false);
  });
});

describe("wire schema v1: batch (the body of POST /v1/e)", () => {
  const validate = validator("batch.json");
  const second = { ...EVENT, event_id: "01934f6c-8d2a-7b3c-9d4e-5f6a7b8c9d0f" };

  it("accepts a batch of events with seq", () => {
    expect(validate({ seq: 3, e: [EVENT, second] }), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects a batch of events without seq, which the loss count would miss (AAI-950)", () => {
    expect(validate({ e: [EVENT] })).toBe(false);
    expect(validate({ e: [EVENT, PURCHASE] })).toBe(false);
  });

  it("accepts a batch of pings without seq", () => {
    expect(validate({ e: [PING, PING] }), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects seq on a batch holding a ping", () => {
    expect(validate({ seq: 1, e: [PING] })).toBe(false);
  });

  it("rejects a batch that mixes events and pings", () => {
    expect(validate({ seq: 2, e: [EVENT, PING] })).toBe(false);
    expect(validate({ e: [PING, EVENT] })).toBe(false);
  });

  it("rejects an empty or missing e", () => {
    expect(validate({ e: [] })).toBe(false);
    expect(validate({ seq: 1, e: [] })).toBe(false);
    expect(validate({ seq: 1 })).toBe(false);
  });

  it("takes 10 items and rejects 11", () => {
    expect(validate({ seq: 1, e: Array(10).fill(EVENT) })).toBe(true);
    expect(validate({ seq: 1, e: Array(11).fill(EVENT) })).toBe(false);
    expect(validate({ e: Array(10).fill(PING) })).toBe(true);
    expect(validate({ e: Array(11).fill(PING) })).toBe(false);
  });

  it("rejects a seq below 1 or fractional", () => {
    expect(validate({ seq: 0, e: [EVENT] })).toBe(false);
    expect(validate({ seq: 1.5, e: [EVENT] })).toBe(false);
  });

  it("rejects a key the schema doesn't list", () => {
    expect(validate({ seq: 1, e: [EVENT], site_id: "site_123" })).toBe(false);
    expect(validate({ e: [PING], v: 1 })).toBe(false);
  });

  it("rejects an item that is neither an event nor a ping", () => {
    expect(validate({ seq: 1, e: [{ ...EVENT, ip: "203.0.113.7" }] })).toBe(false);
    expect(validate({ e: [{ ...PING, visitor_id: EVENT.visitor_id }] })).toBe(false);
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
