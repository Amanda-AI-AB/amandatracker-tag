import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";
import { SCHEMA_BASE } from "../scripts/schema-files.mjs";
import { CLICK_OUTBOUND, CLICK_SPECIAL, EVENT, loadSchemas, PAGE_EXIT, PING, PURCHASE, UUID7, validator, WITHDRAWAL } from "./wire-validator";

/** A batch's page_id: a UUIDv4 (AAI-1050). */
const PAGE_ID = "3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b";

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
    // link_host is the ordinary event's own: a click_outbound's (AAI-167).
    const { type: trackedType, link_host: linkHost, ...trackedRest } = tracked.properties;
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
    // link_host is the ordinary event's own: a click_outbound's (AAI-167).
    const { type: trackedType, link_host: linkHost, ...trackedRest } = tracked.properties;
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

describe("wire schema v1: click_special (AAI-169)", () => {
  const validate = validator("event.json");

  it.each(["tel", "mailto"])("accepts a click_special on a %s: link", (scheme) => {
    expect(validate({ ...CLICK_SPECIAL, link_scheme: scheme }), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each([
    ["the link's address", "tel:+46701234567"],
    ["an email address", "visitor@example.com"],
    ["a scheme with its colon", "mailto:"],
    ["another scheme", "sms"],
    ["an upper-case scheme", "TEL"],
    ["an empty scheme", ""],
  ])("rejects %s as the link's scheme", (_, scheme) => {
    expect(validate({ ...CLICK_SPECIAL, link_scheme: scheme })).toBe(false);
  });

  it("rejects a click_special without its scheme, which no other event may be", () => {
    const { link_scheme, ...rest } = CLICK_SPECIAL;
    expect(validate(rest)).toBe(false);
    expect(validate({ ...EVENT, type: "click_special" })).toBe(false);
  });

  it("rejects a link's scheme on another type of event, a purchase and a page_exit included", () => {
    expect(validate({ ...CLICK_SPECIAL, type: "click" })).toBe(false);
    expect(validate({ ...PURCHASE, link_scheme: "tel" })).toBe(false);
    expect(validate({ ...PAGE_EXIT, link_scheme: "tel" })).toBe(false);
  });

  it.each(["c", "cl", "click", "click_", "click_specia", "click_specials", "click_outbound", "Click_special", "xclick_special", "click_special\n", "clack", "custom"])(
    "takes %j as the type of an ordinary event",
    (type) => {
      expect(validate({ ...EVENT, type }), JSON.stringify(validate.errors)).toBe(true);
    },
  );

  it("still refuses purchase and page_exit as an ordinary event's type", () => {
    expect(validate({ ...EVENT, type: "purchase" })).toBe(false);
    expect(validate({ ...EVENT, type: "page_exit" })).toBe(false);
  });

  it("gives a click_special the same envelope as every other event", () => {
    const defs = loadSchemas()["event.json"]!.$defs as Record<string, { properties: Record<string, unknown>; required: string[] }>;
    const tracked = defs.TrackedEvent!;
    const click = defs.ClickSpecialEvent!;
    // link_host is the ordinary event's own: a click_outbound's (AAI-167).
    const { type: trackedType, link_host: linkHost, ...trackedRest } = tracked.properties;
    const { type: clickType, link_scheme: scheme, ...clickRest } = click.properties;
    expect(clickRest).toEqual(trackedRest);
    expect(clickType).toMatchObject({ const: "click_special" });
    expect(click.required).toEqual([...tracked.required, "link_scheme"]);
  });

  it("rides in a batch and a Pub/Sub message", () => {
    expect(validator("batch.json")({ seq: 1, e: [EVENT, CLICK_SPECIAL] })).toBe(true);
    const message = { schema_version: 1, received_at: 1, region: "europe-west1", device_class: "desktop", event: CLICK_SPECIAL };
    expect(validator("pubsub-message.json")(message)).toBe(true);
  });
});

describe("wire schema v1: click_outbound (AAI-167)", () => {
  const validate = validator("event.json");

  it.each(["partner.example.org", "example.com", "xn--bcher-kva.de", "a_b.example", "192.0.2.1", "[2001:db8::1]", "localhost"])(
    "accepts a click_outbound to the host %s",
    (host) => {
      expect(validate({ ...CLICK_OUTBOUND, link_host: host }), JSON.stringify(validate.errors)).toBe(true);
    },
  );

  it.each([
    ["a full URL", "https://partner.example.org/offer?id=1"],
    ["a host with its path", "partner.example.org/offer"],
    ["a host with its port", "partner.example.org:8443"],
    ["a host with credentials", "user@partner.example.org"],
    ["an upper-case host", "Partner.Example.org"],
    ["a host with a trailing dot", "example.com."],
    ["an empty label", "partner..example.org"],
    ["an empty host", ""],
    ["a host over 253 characters", `${"a".repeat(250)}.com`],
  ])("rejects %s as the link's host", (_, host) => {
    expect(validate({ ...CLICK_OUTBOUND, link_host: host })).toBe(false);
  });

  it("rejects a link's host on a purchase, a page_exit and a click_special", () => {
    expect(validate({ ...PURCHASE, link_host: "example.org" })).toBe(false);
    expect(validate({ ...PAGE_EXIT, link_host: "example.org" })).toBe(false);
    expect(validate({ ...CLICK_SPECIAL, link_host: "example.org" })).toBe(false);
  });

  it("rides in a batch and a Pub/Sub message", () => {
    expect(validator("batch.json")({ seq: 1, e: [EVENT, CLICK_OUTBOUND] })).toBe(true);
    const message = { schema_version: 1, received_at: 1, region: "europe-west1", device_class: "desktop", event: CLICK_OUTBOUND };
    expect(validator("pubsub-message.json")(message)).toBe(true);
  });
});

describe("wire schema v1: anonymous ping", () => {
  const validate = validator("ping.json");

  it("accepts a ping", () => {
    expect(validate(PING), JSON.stringify(validate.errors)).toBe(true);
  });

  it("has exactly the frozen field list, and the click_ids of a site that turned them on (AAI-801)", () => {
    const ping = loadSchemas()["ping.json"]!;
    expect(Object.keys(ping.properties as object)).toEqual([
      "schema_version",
      "event_id",
      "site_id",
      "type",
      "path",
      "referrer_host",
      "utm",
      "click_ids",
    ]);
    expect(ping.additionalProperties).toBe(false);
    expect(ping.required).not.toContain("click_ids");
  });

  it("accepts the ad platforms' click IDs in click_ids, and nothing else there", () => {
    expect(validate({ ...PING, click_ids: { gclid: "a", gbraid: "b", wbraid: "c", fbclid: "d", msclkid: "e" } })).toBe(true);
    expect(validate({ ...PING, click_ids: { dclid: "x" } })).toBe(false);
    expect(validate({ ...PING, click_ids: { gclid: "" } })).toBe(false);
  });

  it.each([
    ["visitor_id", EVENT.visitor_id],
    ["session_id", EVENT.session_id],
    ["seq", 3],
    ["gclid", "abc"],
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

  it("refuses the subdivision, browser family and major and OS family outside an event's message (06 §3, AAI-1148)", () => {
    const derived = { subdivision: "SE-AB", browser_family: "Chrome", browser_major: 131, os_family: "Windows" };
    // The review's proof: a ping's message with a subdivision and a browser family.
    expect(validate({ ...message, device_class: "desktop", subdivision: "SE-AB", browser_family: "Chrome", event: PING })).toBe(false);
    for (const [key, value] of Object.entries(derived)) {
      expect(validate({ ...message, [key]: value, event: PING }), `${key} on a ping's`).toBe(false);
      expect(validate({ ...message, [key]: value, event: WITHDRAWAL }), `${key} on a withdrawal's`).toBe(false);
      expect(validate({ ...message, [key]: value, event: EVENT }), `${key} on an event's`).toBe(true);
    }
    // Country and device class stay on both.
    expect(validate({ ...message, event: PING }), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...message, event: WITHDRAWAL }), JSON.stringify(validate.errors)).toBe(true);
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

  it("carries an event's city, for a site that turned city-level geo on, and is valid without it (AAI-1144)", () => {
    for (const city of ["Stockholm", "São Paulo", "x", "x".repeat(128)]) {
      expect(validate({ ...message, subdivision: "SE-AB", city, event: EVENT }), JSON.stringify(validate.errors)).toBe(true);
    }
    expect(validate({ ...message, subdivision: "SE-AB", event: EVENT }), JSON.stringify(validate.errors)).toBe(true);
  });

  it("refuses a city that isn't a non-empty string of at most 128 characters (AAI-1144)", () => {
    for (const city of ["", "x".repeat(129), 1, true, null, ["Stockholm"], { name: "Stockholm" }]) {
      expect(validate({ ...message, city, event: EVENT }), JSON.stringify(city)).toBe(false);
    }
  });

  it("refuses the city on a ping's, a withdrawal signal's or a tag error's message (06 §3, AAI-1144)", () => {
    const tagError = { schema_version: 1, event_id: UUID7, tag_version: "0.4.0", site_id: "site_123", stage: "transport", name: "TypeError" };
    const { country, device_class, ...bare } = message;
    expect(validate({ ...message, city: "Stockholm", event: PING })).toBe(false);
    expect(validate({ ...message, city: "Stockholm", event: WITHDRAWAL })).toBe(false);
    expect(validate({ ...bare, city: "Stockholm", event: tagError })).toBe(false);
  });

  it("carries an event's batch seq and page_id, for the seq-gap loss metric (AAI-1050)", () => {
    expect(validate({ ...message, seq: 3, page_id: PAGE_ID, event: EVENT }), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...message, seq: 3, event: EVENT }), JSON.stringify(validate.errors)).toBe(true);
  });

  it("refuses seq and page_id outside an event's message, which would link pings (08 G2, AAI-1146)", () => {
    const tagError = { schema_version: 1, event_id: UUID7, tag_version: "0.4.0", site_id: "site_123", stage: "transport", name: "TypeError" };
    const { device_class, ...noDevice } = message;
    expect(validate({ ...message, seq: 3, page_id: PAGE_ID, event: PING })).toBe(false);
    expect(validate({ ...message, seq: 3, event: PING })).toBe(false);
    expect(validate({ ...message, page_id: PAGE_ID, event: PING })).toBe(false);
    expect(validate({ ...message, seq: 3, event: WITHDRAWAL })).toBe(false);
    expect(validate({ ...message, page_id: PAGE_ID, event: WITHDRAWAL })).toBe(false);
    expect(validate({ ...noDevice, seq: 3, page_id: PAGE_ID, event: tagError })).toBe(false);
    expect(validate({ ...noDevice, seq: 3, event: tagError })).toBe(false);
    expect(validate({ ...noDevice, page_id: PAGE_ID, event: tagError })).toBe(false);
  });

  it("carries an event's or a ping's bot mark, and is valid without it (AAI-1001)", () => {
    expect(validate({ ...message, is_bot: true, event: EVENT }), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...message, is_bot: true, event: PING }), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...message, event: EVENT }), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...message, event: PING }), JSON.stringify(validate.errors)).toBe(true);
  });

  it("refuses an is_bot other than true: the collector leaves it out instead (AAI-1001)", () => {
    for (const is_bot of [false, "true", 1, null]) {
      expect(validate({ ...message, is_bot, event: EVENT }), JSON.stringify(is_bot)).toBe(false);
      expect(validate({ ...message, is_bot, event: PING }), JSON.stringify(is_bot)).toBe(false);
    }
  });

  it("refuses is_bot on a withdrawal signal's or a tag error's message (AAI-1001)", () => {
    const tagError = { schema_version: 1, event_id: UUID7, tag_version: "0.4.0", site_id: "site_123", stage: "transport", name: "TypeError" };
    const { country, device_class, ...bare } = message;
    expect(validate({ ...message, is_bot: true, event: WITHDRAWAL })).toBe(false);
    expect(validate({ ...bare, is_bot: true, event: tagError })).toBe(false);
    expect(validate({ ...bare, event: tagError }), JSON.stringify(validate.errors)).toBe(true);
  });

  it("checks the shape of seq and page_id", () => {
    for (const seq of [0, 1.5, "1"]) expect(validate({ ...message, seq, event: EVENT }), String(seq)).toBe(false);
    expect(validate({ ...message, seq: 1, page_id: EVENT.visitor_id, event: EVENT })).toBe(false);
  });

  describe("a tag error (AAI-1142)", () => {
    const tagError = { schema_version: 1, event_id: UUID7, tag_version: "0.4.0", site_id: "site_123", stage: "transport", name: "TypeError" };
    const tagErrorMessage = { schema_version: 1, received_at: 1_731_400_000_123, region: "europe-west1", event: tagError };

    it("is carried without device_class, geo or user-agent fields", () => {
      expect(validate(tagErrorMessage), JSON.stringify(validate.errors)).toBe(true);
      expect(validator("tag-error.json")(tagError)).toBe(true);
    });

    it("is refused with its message", () => {
      expect(validate({ ...tagErrorMessage, event: { ...tagError, message: "x is not a function" } })).toBe(false);
    });

    it.each([
      ["country", "SE"],
      ["subdivision", "SE-AB"],
      ["city", "Stockholm"],
      ["device_class", "desktop"],
      ["browser_family", "Chrome"],
      ["browser_major", 131],
      ["os_family", "Windows"],
    ])("is refused with %s", (field, value) => {
      expect(validate({ ...tagErrorMessage, [field]: value })).toBe(false);
    });

    it("is refused without its site_id", () => {
      const { site_id, ...noSite } = tagError;
      expect(validator("tag-error.json")(noSite)).toBe(true);
      expect(validate({ ...tagErrorMessage, event: noSite })).toBe(false);
    });

    it("is refused without its stage or name, or with a stage the tag doesn't send", () => {
      const { stage, ...noStage } = tagError;
      const { name, ...noName } = tagError;
      expect(validate({ ...tagErrorMessage, event: noStage })).toBe(false);
      expect(validate({ ...tagErrorMessage, event: noName })).toBe(false);
      expect(validate({ ...tagErrorMessage, event: { ...tagError, stage: "render" } })).toBe(false);
    });

    it("matches exactly one branch of event, so the oneOf stays exclusive", () => {
      const ajv = new Ajv2020({ strict: true });
      for (const schema of Object.values(loadSchemas())) ajv.addSchema(schema);
      const branches = ["event.json", "ping.json", "withdrawal.json", "pubsub-message.json#/$defs/PublishedTagError"];
      for (const payload of [tagError, EVENT, PURCHASE, PING, WITHDRAWAL]) {
        const matching = branches.filter((branch) => ajv.getSchema(`${SCHEMA_BASE}/v1/${branch}`)!(payload));
        expect(matching, JSON.stringify(payload)).toHaveLength(1);
      }
    });
  });

  it("still needs device_class on an event, a ping and a withdrawal signal (AAI-1142)", () => {
    const { device_class, ...noDevice } = message;
    for (const event of [EVENT, PING, WITHDRAWAL]) {
      expect(validate({ ...message, event }), JSON.stringify(validate.errors)).toBe(true);
      expect(validate({ ...noDevice, event })).toBe(false);
    }
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

  it("accepts webdriver: true on a batch of events, for the collector's bot marking (AAI-796)", () => {
    expect(validate({ seq: 1, e: [EVENT], webdriver: true }), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects a webdriver other than true: the tag leaves it out instead", () => {
    expect(validate({ seq: 1, e: [EVENT], webdriver: false })).toBe(false);
    expect(validate({ seq: 1, e: [EVENT], webdriver: "true" })).toBe(false);
    expect(validate({ seq: 1, e: [EVENT], webdriver: 1 })).toBe(false);
  });

  it("rejects webdriver on a batch of pings, whose field list is frozen", () => {
    expect(validate({ e: [PING], webdriver: true })).toBe(false);
  });

  it("accepts a UUIDv4 page_id on a batch of events, and a batch without one from a tag up to v0.4.0 (AAI-1050)", () => {
    expect(validate({ seq: 1, page_id: PAGE_ID, e: [EVENT] }), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ seq: 1, e: [EVENT] }), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects a page_id that isn't a lower-case UUIDv4, such as a UUIDv7 that carries a time", () => {
    for (const pageId of [EVENT.visitor_id, PAGE_ID.toUpperCase(), PAGE_ID.replace(/-/g, ""), "", 42]) {
      expect(validate({ seq: 1, page_id: pageId, e: [EVENT] }), String(pageId)).toBe(false);
    }
  });

  it("rejects page_id on a batch of pings, which are never sequence-linkable (08 G2)", () => {
    expect(validate({ page_id: PAGE_ID, e: [PING] })).toBe(false);
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
