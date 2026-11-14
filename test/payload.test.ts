import { describe, expect, it, vi } from "vitest";
import { PURCHASE_EVENT_SHAPE, TRACKED_EVENT_SHAPE, WIRE_PING_SHAPE, WIRE_TAG_ERROR_SHAPE } from "../src/wire/generated";
import {
  buildEvent,
  buildPing,
  compiledPattern,
  cutSubtags,
  cutText,
  OVERFLOW,
  PING_ID_PERIOD_MS,
  pingId,
  STRIP_FROM,
  stripFrom,
  UPPER_CASE,
  uuidv7,
  WirePayloadError,
  type EventInput,
  type PageExitEventInput,
  type PurchaseEventInput,
  type Shape,
  type PingInput,
  type TrackedEventInput,
} from "../src/wire/payload";
import { EVENT, PAGE_EXIT, PING, PURCHASE, validator } from "./wire-validator";

type Items = NonNullable<PurchaseEventInput["purchase"]["items"]>;

// The schema's UUIDv7 pattern, which every id field shares.
const UUID7_PATTERN = new RegExp(TRACKED_EVENT_SHAPE.pattern.event_id);

function eventInput(): TrackedEventInput {
  const { schema_version, event_id, ...input } = EVENT;
  return { ...input, consent: { ...input.consent }, props: { ...input.props } };
}

function purchaseInput(): PurchaseEventInput {
  const { schema_version, event_id, ...input } = PURCHASE;
  const items = input.purchase.items.map((item) => ({ ...item })) as Items;
  return { ...input, consent: { ...input.consent }, props: { ...input.props }, purchase: { ...input.purchase, items } };
}

function pingInput(): PingInput {
  const { schema_version, event_id, ...input } = PING;
  return { ...input, utm: { ...input.utm } };
}

describe("uuidv7", () => {
  it("is a version-7 UUID with the time in its first 48 bits", () => {
    const now = 1_731_400_000_000;
    const id = uuidv7(now);
    expect(id).toMatch(UUID7_PATTERN);
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

describe("pingId", () => {
  const time = (id: string) => parseInt(id.slice(0, 8) + id.slice(9, 13), 16);

  it("rounds the time down to the hour, so the ID holds no clock skew finer than that", () => {
    const hour = 1_731_398_400_000;
    expect(hour % PING_ID_PERIOD_MS).toBe(0);
    for (const now of [hour, hour + 1, hour + 1_234_567, hour + PING_ID_PERIOD_MS - 1]) {
      const id = pingId(now);
      expect(id).toMatch(UUID7_PATTERN);
      expect(time(id)).toBe(hour);
    }
    expect(time(pingId(hour + PING_ID_PERIOD_MS))).toBe(hour + PING_ID_PERIOD_MS);
  });

  it("stays inside the collector's window: never after now, under an hour before (AAI-835)", () => {
    const now = 1_731_400_000_000;
    const ms = time(pingId(now));
    expect(ms).toBeLessThanOrEqual(now);
    expect(now - ms).toBeLessThan(PING_ID_PERIOD_MS);
  });

  it("keeps the UTC month: a month's first millisecond stays in it", () => {
    const december = Date.UTC(2026, 11, 1);
    expect(time(pingId(december))).toBe(december);
    expect(time(pingId(december - 1))).toBe(december - PING_ID_PERIOD_MS);
  });

  it("is random beyond its time", () => {
    const now = 1_731_400_000_000;
    expect(pingId(now)).not.toBe(pingId(now));
    expect(pingId(now, new Uint8Array(10))).toBe(uuidv7(Math.floor(now / PING_ID_PERIOD_MS) * PING_ID_PERIOD_MS, new Uint8Array(10)));
  });
});

describe("buildEvent", () => {
  const validate = validator("event.json");

  it("builds a valid event with the schema version and a fresh UUIDv7", () => {
    const event = buildEvent(eventInput());
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
    expect(event.schema_version).toBe(1);
    expect(event.event_id).toMatch(UUID7_PATTERN);
  });

  it("leaves out fields the schema doesn't list, and empty optional strings", () => {
    const input = { ...eventInput(), referrer: "", ip: "203.0.113.7" } as TrackedEventInput;
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

  it("counts characters by code point, as the schema's maxLength does, and never cuts a pair in two", () => {
    const within = `${"a".repeat(511)}😀`;
    expect(buildEvent({ ...eventInput(), page_title: within }).page_title).toBe(within);
    const event = buildEvent({ ...eventInput(), page_title: `${"a".repeat(511)}😀b` });
    expect(event.page_title).toBe(within);
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
  });

  it("keeps emoji text within its cap whole, and cuts it over the cap to the cap's count of emoji", () => {
    const title = "😀".repeat(300);
    expect(buildEvent({ ...eventInput(), page_title: title }).page_title).toBe(title);
    const cut = buildEvent({ ...eventInput(), page_title: "😀".repeat(600) });
    expect(cut.page_title).toBe("😀".repeat(512));
    expect(validate(cut), JSON.stringify(validate.errors)).toBe(true);
    const props = buildEvent({ ...eventInput(), props: { note: "🛒".repeat(201) } }).props;
    expect(props?.note).toBe("🛒".repeat(200));
  });

  it("takes an identifier of emoji within its cap in code points, and refuses one over it", () => {
    const type = "🛒".repeat(40);
    expect(buildEvent({ ...eventInput(), type }).type).toBe(type);
    expect(buildEvent({ ...eventInput(), type: "🛒".repeat(64) }).type).toBe("🛒".repeat(64));
    expect(() => buildEvent({ ...eventInput(), type: "🛒".repeat(65) })).toThrow(
      new WirePayloadError("event.type", "is over its cap of 64 characters"),
    );
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
  it("counts a surrogate pair as one character and never cuts it in two", () => {
    expect(cutText("ab😀", 2)).toBe("ab");
    expect(cutText("ab😀", 3)).toBe("ab😀");
    expect(cutText("ab😀c", 3)).toBe("ab😀");
    expect(cutText("😀😀", 1)).toBe("😀");
    expect(cutText("😀", 0)).toBe("");
    expect(cutText("ab", 5)).toBe("ab");
  });

  it("counts a lone surrogate as one character, as the schema's validators do", () => {
    expect(cutText("a\ud83db", 2)).toBe("a\ud83d");
    expect(cutText("a\ude00b", 2)).toBe("a\ude00");
    expect(cutText("\ude00\ud83d😀", 3)).toBe("\ude00\ud83d😀");
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
  const shapes: [string, Shape][] = [
    ["event", TRACKED_EVENT_SHAPE],
    ["event", PURCHASE_EVENT_SHAPE],
    ["ping", WIRE_PING_SHAPE],
    ["tag_error", WIRE_TAG_ERROR_SHAPE],
  ];

  function capped(prefix: string, spec: Shape): { at: string; required: boolean }[] {
    return [
      ...Object.keys(spec.maxLength).map((field) => ({ at: `${prefix}.${field}`, required: spec.required.includes(field) })),
      ...Object.entries(spec.nested).flatMap(([field, inner]) => capped(`${prefix}.${field}`, inner)),
      ...Object.entries(spec.items).flatMap(([field, inner]) => capped(`${prefix}.${field}[]`, inner)),
      ...Object.entries(spec.maps)
        .filter(([, map]) => map.maxLength !== undefined)
        .map(([field]) => ({ at: `${prefix}.${field}.*`, required: false })),
    ];
  }
  const all = shapes.flatMap(([prefix, spec]) => capped(prefix, spec));

  it("names only capped fields", () => {
    for (const at of Object.keys(OVERFLOW)) expect(all.map((field) => field.at)).toContain(at);
  });

  it("can leave out only optional fields", () => {
    for (const { at, required } of all) {
      if (required) expect([undefined, "cut"]).toContain(OVERFLOW[at]);
    }
  });

  it("UPPER_CASE names only capped strings", () => {
    for (const at of UPPER_CASE) expect(all.map((field) => field.at)).toContain(at);
  });
});

describe("buildPing", () => {
  const validate = validator("ping.json");

  it("builds a valid ping", () => {
    const ping = buildPing(pingInput());
    expect(validate(ping), JSON.stringify(validate.errors)).toBe(true);
    expect(ping.event_id).toMatch(UUID7_PATTERN);
  });

  it("mints an event_id whose time is the start of the hour, not the browser's millisecond (AAI-929)", () => {
    const before = Date.now();
    const ping = buildPing(pingInput());
    const after = Date.now();
    const ms = parseInt(ping.event_id.replace(/-/g, "").slice(0, 12), 16);
    const hour = (t: number) => Math.floor(t / PING_ID_PERIOD_MS) * PING_ID_PERIOD_MS;
    expect([hour(before), hour(after)]).toContain(ms);
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
    } as unknown as PingInput;
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
    const ping = buildPing({ ...pingInput(), path: `/${"p".repeat(2046)}😀😀`, referrer_host: `${"h".repeat(250)}.example` });
    expect(ping.path).toBe(`/${"p".repeat(2046)}😀`);
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
    const consent = { ...input.consent, functional: "granted" } as EventInput["consent"];
    const event = buildEvent({ ...input, consent });
    expect(Object.keys(event.consent).sort()).toEqual(["ads", "analytics"]);
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
  });

  it("carries the snapshot's source, and refuses one off its list", () => {
    const input = eventInput();
    const event = buildEvent({ ...input, consent: { ...input.consent, source: "gcm" } });
    expect(event.consent.source).toBe("gcm");
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
    const consent = { ...input.consent, source: "cookiebot" } as unknown as EventInput["consent"];
    expect(() => buildEvent({ ...input, consent })).toThrow(new WirePayloadError("event.consent.source", "is not one of gpc, manual, gcm"));
  });
});

describe("buildEvent props", () => {
  const validate = validator("event.json");
  const withProps = (props: unknown) => buildEvent({ ...eventInput(), props } as TrackedEventInput);

  it("keeps strings, numbers and booleans", () => {
    const event = withProps({ plan: "pro", seats: 3, price: 9.5, trial: false, note: "" });
    expect(event.props).toEqual({ plan: "pro", seats: 3, price: 9.5, trial: false, note: "" });
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
  });

  it("does not hand back the caller's props object", () => {
    const input = eventInput();
    expect(buildEvent(input).props).not.toBe(input.props);
  });

  it("is not changed when the caller mutates its props after building (AAI-944)", () => {
    const props: Record<string, string | number | boolean> = { sku: "A-1", qty: 1 };
    const event = buildEvent({ ...eventInput(), props });
    props.qty = 99;
    props.added = true;
    delete props.sku;
    expect(event.props).toEqual({ sku: "A-1", qty: 1 });
  });

  it("is not changed when the caller mutates its purchase or items after building (AAI-944)", () => {
    const input = purchaseInput();
    const event = buildEvent(input);
    const before = structuredClone(event);
    input.purchase.revenue = 1;
    input.purchase.items![0]!.qty = 99;
    input.purchase.items!.push({ ...input.purchase.items![0]! });
    expect(event).toEqual(before);
  });

  it("leaves out keys whose value is undefined, and props that end up empty", () => {
    expect(withProps({ plan: "pro", gone: undefined }).props).toEqual({ plan: "pro" });
    expect(withProps({ gone: undefined })).not.toHaveProperty("props");
    expect(withProps({})).not.toHaveProperty("props");
  });

  it("cuts a string over 200 characters on a whole character", () => {
    expect(withProps({ s: `${"x".repeat(199)}😀` }).props!.s).toBe(`${"x".repeat(199)}😀`);
    const event = withProps({ s: `${"x".repeat(199)}😀😀` });
    expect(event.props!.s).toBe(`${"x".repeat(199)}😀`);
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each([
    ["an object", { nested: { a: 1 } }, "event.props.nested"],
    ["an array", { list: [1] }, "event.props.list"],
    ["null", { gone: null }, "event.props.gone"],
    ["NaN", { n: Number.NaN }, "event.props.n"],
    ["Infinity", { n: Number.POSITIVE_INFINITY }, "event.props.n"],
  ])("throws on %s as a value, rather than drop what the site sent", (_, props, at) => {
    expect(() => withProps(props)).toThrow(new WirePayloadError(at, "is not one of string, number, boolean"));
  });

  it.each(["am_", "am_source"])("throws on the reserved key %s", (key) => {
    expect(() => withProps({ [key]: "x" })).toThrow(new WirePayloadError(`event.props.${key}`, "is a reserved or empty key"));
  });

  it("throws on an empty key", () => {
    expect(() => withProps({ "": "x" })).toThrow(new WirePayloadError("event.props.", "is a reserved or empty key"));
  });

  it("takes 25 keys and throws on 26", () => {
    const props = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(withProps(props(25)).props!)).toHaveLength(25);
    expect(() => withProps(props(26))).toThrow(new WirePayloadError("event.props", "has more than 25 keys"));
  });

  it("throws when props isn't an object", () => {
    expect(() => withProps(["a"])).toThrow(new WirePayloadError("event.props", "is not an object"));
    expect(() => withProps("a")).toThrow(new WirePayloadError("event.props", "is not an object"));
  });
});

describe("buildEvent page_exit (AAI-105)", () => {
  const validate = validator("event.json");

  function pageExitInput(): PageExitEventInput {
    const { schema_version, event_id, ...input } = PAGE_EXIT;
    return { ...input, consent: { ...input.consent }, props: { ...input.props } };
  }

  it("builds a valid page_exit with its engagement time, 0 included", () => {
    const event = buildEvent(pageExitInput());
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
    expect(event).toMatchObject({ type: "page_exit", engagement_ms: 42_500 });
    const idle = buildEvent({ ...pageExitInput(), engagement_ms: 0 });
    expect(idle).toMatchObject({ engagement_ms: 0 });
    expect(validate(idle), JSON.stringify(validate.errors)).toBe(true);
  });

  it("throws when the engagement time is on another type of event", () => {
    const input = { ...pageExitInput(), type: "pageview" } as unknown as EventInput;
    expect(() => buildEvent(input)).toThrow(new WirePayloadError("event.type", 'is not "page_exit" on an event with an engagement_ms'));
  });

  it("throws on an event of type page_exit without its engagement time", () => {
    const { engagement_ms, ...rest } = pageExitInput();
    expect(() => buildEvent(rest as unknown as EventInput)).toThrow(new WirePayloadError("event.engagement_ms"));
    expect(() => buildEvent({ ...EVENT, type: "page_exit" } as unknown as EventInput)).toThrow(
      new WirePayloadError("event.engagement_ms"),
    );
  });

  it.each([
    ["negative", -1, "is under its minimum of 0"],
    ["fractional", 1.5, "is not an integer"],
    ["NaN", Number.NaN, "is not an integer"],
  ])("throws on a %s engagement time", (_, engagement, problem) => {
    expect(() => buildEvent({ ...pageExitInput(), engagement_ms: engagement })).toThrow(
      new WirePayloadError("event.engagement_ms", problem),
    );
  });
});

describe("buildEvent purchase", () => {
  const validate = validator("event.json");

  it("builds a valid purchase with its order and items", () => {
    const event = buildEvent(purchaseInput());
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
    expect(event).toMatchObject({ type: "purchase", purchase: PURCHASE.purchase });
  });

  it("keeps the order and its items to their field lists, and hands back none of the caller's objects", () => {
    const input = purchaseInput();
    const extra = {
      ...input,
      purchase: { ...input.purchase, coupon: "NOV10", items: [{ ...PURCHASE.purchase.items[0], color: "red" }] },
    } as unknown as PurchaseEventInput;
    const event = buildEvent(extra);
    expect(event).toMatchObject({ purchase: { items: [PURCHASE.purchase.items[0]] } });
    expect(event).not.toHaveProperty("purchase.coupon");
    expect(event).not.toHaveProperty("purchase.items.0.color");
    expect("purchase" in event && event.purchase).not.toBe(input.purchase);
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
  });

  it("leaves out an empty item list and an empty item name", () => {
    const input = purchaseInput();
    const event = buildEvent({ ...input, purchase: { ...input.purchase, items: [] as unknown as Items } });
    expect(event).not.toHaveProperty("purchase.items");
    const named = buildEvent({ ...input, purchase: { ...input.purchase, items: [{ sku: "a", name: "", qty: 1, price: 1 }] } });
    expect(named).not.toHaveProperty("purchase.items.0.name");
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(named), JSON.stringify(validate.errors)).toBe(true);
  });

  it("throws when the purchase is on another type of event", () => {
    const input = { ...purchaseInput(), type: "pageview" } as unknown as EventInput;
    expect(() => buildEvent(input)).toThrow(new WirePayloadError("event.type", 'is not "purchase" on an event with a purchase'));
  });

  it("builds an ordinary event when the input carries no purchase", () => {
    const { purchase, ...rest } = purchaseInput();
    const event = buildEvent({ ...rest, type: "add_to_cart" });
    expect(event).not.toHaveProperty("purchase");
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
  });

  it("throws on an event of type purchase without its purchase, rather than send an order with no order_id (AAI-921)", () => {
    const { purchase, ...rest } = purchaseInput();
    expect(() => buildEvent(rest)).toThrow(new WirePayloadError("event.purchase"));
    expect(() => buildEvent({ ...rest, purchase: undefined } as unknown as EventInput)).toThrow(
      new WirePayloadError("event.purchase"),
    );
  });

  it.each(["order_id", "currency"] as const)("throws when the required %s is empty or missing", (field) => {
    const input = purchaseInput();
    expect(() => buildEvent({ ...input, purchase: { ...input.purchase, [field]: "" } })).toThrow(
      new WirePayloadError(`event.purchase.${field}`),
    );
  });

  it("throws on an item without a sku, naming the item", () => {
    const input = purchaseInput();
    const items = [{ ...PURCHASE.purchase.items[0] }, { qty: 1, price: 1 }] as unknown as Items;
    expect(() => buildEvent({ ...input, purchase: { ...input.purchase, items } })).toThrow(
      new WirePayloadError("event.purchase.items[1].sku"),
    );
  });

  it("throws on an order_id or sku over its cap, rather than send it as another one", () => {
    const input = purchaseInput();
    expect(() => buildEvent({ ...input, purchase: { ...input.purchase, order_id: "o".repeat(129) } })).toThrow(
      new WirePayloadError("event.purchase.order_id", "is over its cap of 128 characters"),
    );
    const items: Items = [{ sku: "s".repeat(129), qty: 1, price: 1 }];
    expect(() => buildEvent({ ...input, purchase: { ...input.purchase, items } })).toThrow(
      new WirePayloadError("event.purchase.items[0].sku", "is over its cap of 128 characters"),
    );
  });

  it("cuts an item name over 200 characters", () => {
    const input = purchaseInput();
    const items: Items = [{ sku: "a", name: "n".repeat(250), qty: 1, price: 1 }];
    const event = buildEvent({ ...input, purchase: { ...input.purchase, items } });
    expect(event).toHaveProperty("purchase.items.0.name", "n".repeat(200));
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
  });

  it("takes 50 items and throws on 51, rather than cut the order", () => {
    const input = purchaseInput();
    const items = (count: number) => Array.from({ length: count }, () => ({ sku: "a", qty: 1, price: 1 })) as Items;
    expect(validate(buildEvent({ ...input, purchase: { ...input.purchase, items: items(50) } }))).toBe(true);
    expect(() => buildEvent({ ...input, purchase: { ...input.purchase, items: items(51) } })).toThrow(
      new WirePayloadError("event.purchase.items", "has more than 50 items"),
    );
  });

  describe("an item list's minimum (AAI-952)", () => {
    /**
     * buildEvent with a Purchase whose items have minItems of least, and are required when required
     * is: v1 has neither a required array nor a minItems over 1, which the builder must keep too.
     */
    async function builderWith(least: number, required: boolean): Promise<typeof buildEvent> {
      vi.resetModules();
      vi.doMock("../src/wire/generated", async (importOriginal) => {
        const wire = await importOriginal<typeof import("../src/wire/generated")>();
        const purchase = {
          ...wire.PURCHASE_SHAPE,
          required: required ? [...wire.PURCHASE_SHAPE.required, "items"] : wire.PURCHASE_SHAPE.required,
          minItems: { items: least },
        };
        const event = wire.PURCHASE_EVENT_SHAPE;
        return { ...wire, PURCHASE_EVENT_SHAPE: { ...event, nested: { ...event.nested, purchase } } };
      });
      try {
        return (await import("../src/wire/payload")).buildEvent;
      } finally {
        vi.doUnmock("../src/wire/generated");
        vi.resetModules();
      }
    }
    const items = (count: number) => Array.from({ length: count }, () => ({ sku: "a", qty: 1, price: 1 })) as unknown as Items;

    it("throws on an empty required item list, rather than send it", async () => {
      const build = await builderWith(1, true);
      const input = purchaseInput();
      expect(() => build({ ...input, purchase: { ...input.purchase, items: items(0) } })).toThrow(
        "wire payload: event.purchase.items has fewer than 1 items",
      );
      expect(build({ ...input, purchase: { ...input.purchase, items: items(1) } })).toHaveProperty("purchase.items.length", 1);
    });

    it("throws on an optional item list under its minimum, and still leaves out an empty one", async () => {
      const build = await builderWith(2, false);
      const input = purchaseInput();
      expect(() => build({ ...input, purchase: { ...input.purchase, items: items(1) } })).toThrow(
        "wire payload: event.purchase.items has fewer than 2 items",
      );
      expect(build({ ...input, purchase: { ...input.purchase, items: items(0) } })).not.toHaveProperty("purchase.items");
      expect(build({ ...input, purchase: { ...input.purchase, items: items(2) } })).toHaveProperty("purchase.items.length", 2);
    });
  });

  it("throws on an item that isn't an object", () => {
    const input = purchaseInput();
    const items = ["a"] as unknown as Items;
    expect(() => buildEvent({ ...input, purchase: { ...input.purchase, items } })).toThrow(
      new WirePayloadError("event.purchase.items[0]", "is not an object"),
    );
  });
});

describe("buildEvent purchase values (AAI-919)", () => {
  const validate = validator("event.json");
  const build = (purchase: unknown) => buildEvent({ ...purchaseInput(), purchase } as unknown as EventInput);
  const order = PURCHASE.purchase;

  it.each([
    ["NaN revenue", { ...order, revenue: Number.NaN }, "event.purchase.revenue", "is not a finite number"],
    ["Infinity revenue", { ...order, revenue: Number.POSITIVE_INFINITY }, "event.purchase.revenue", "is not a finite number"],
    ["revenue as a string", { ...order, revenue: "249.90" }, "event.purchase.revenue", "is not a finite number"],
    ["negative revenue", { ...order, revenue: -5 }, "event.purchase.revenue", "is under its minimum of 0"],
    ["a currency that isn't three letters", { ...order, currency: "kr" }, "event.purchase.currency", "does not match ^[A-Z]{3}$"],
    ["a currency as a number", { ...order, currency: 752 }, "event.purchase.currency", "is not a string"],
    ["order_id as a number", { ...order, order_id: 1001 }, "event.purchase.order_id", "is not a string"],
    ["items not an array", { ...order, items: { sku: "x", qty: 1, price: 1 } }, "event.purchase.items", "is not an array"],
    ["qty 0", { ...order, items: [{ sku: "x", qty: 0, price: 1 }] }, "event.purchase.items[0].qty", "is under its minimum of 1"],
    ["qty 1.5", { ...order, items: [{ sku: "x", qty: 1.5, price: 1 }] }, "event.purchase.items[0].qty", "is not an integer"],
    ["qty as a string", { ...order, items: [{ sku: "x", qty: "2", price: 1 }] }, "event.purchase.items[0].qty", "is not an integer"],
    ["a negative price", { ...order, items: [{ sku: "x", qty: 1, price: -1 }] }, "event.purchase.items[0].price", "is under its minimum of 0"],
    ["a price as a string", { ...order, items: [{ sku: "x", qty: 1, price: "1" }] }, "event.purchase.items[0].price", "is not a finite number"],
  ])("throws on %s, rather than send a purchase the collector refuses", (_, purchase, at, problem) => {
    expect(() => build(purchase)).toThrow(new WirePayloadError(at, problem));
  });

  it.each([
    ["null", null],
    ["a string", "1001"],
    ["an array", [order]],
  ])("throws on %s as the purchase, which isn't an object", (_, purchase) => {
    expect(() => build(purchase)).toThrow(new WirePayloadError("event.purchase", "is not an object"));
  });

  it("upper-cases a lower-case currency", () => {
    const event = build({ ...order, currency: "sek" });
    expect(event).toHaveProperty("purchase.currency", "SEK");
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
  });

  it("takes a revenue and a price of 0", () => {
    const event = build({ ...order, revenue: 0, items: [{ sku: "x", qty: 1, price: 0 }] });
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe("buildEvent envelope values (AAI-919)", () => {
  it.each([
    ["client_ts as a string", { client_ts: "1731400000000" }, "event.client_ts", "is not an integer"],
    ["a fractional client_ts", { client_ts: 1.5 }, "event.client_ts", "is not an integer"],
    ["a negative client_ts", { client_ts: -1 }, "event.client_ts", "is under its minimum of 0"],
    ["url as a number", { url: 1 }, "event.url", "is not a string"],
    ["a visitor_id that isn't a UUIDv7", { visitor_id: "abc" }, "event.visitor_id", "does not match"],
    ["a tag_version that isn't semver", { tag_version: "v1" }, "event.tag_version", "does not match"],
    ["a site_id with a space", { site_id: "site 1" }, "event.site_id", "does not match"],
    ["consent as a string", { consent: "granted" }, "event.consent", "is not an object"],
    ["a consent state off its list", { consent: { analytics: "yes", ads: "denied" } }, "event.consent.analytics", "is not one of granted, denied, unknown, no_cmp"],
  ])("throws on %s", (_, change, at, problem) => {
    expect(() => buildEvent({ ...eventInput(), ...change } as unknown as EventInput)).toThrow(WirePayloadError);
    expect(() => buildEvent({ ...eventInput(), ...change } as unknown as EventInput)).toThrow(`wire payload: ${at} ${problem}`);
  });
});

describe("null and untyped values (AAI-933)", () => {
  const validate = validator("event.json");
  const pingValidate = validator("ping.json");
  const build = (change: object) => buildEvent({ ...eventInput(), ...change } as unknown as EventInput);

  it.each(["site_id", "url", "client_ts", "consent", "visitor_id"])("throws on a required %s given as null, as missing", (field) => {
    expect(() => build({ [field]: null })).toThrow(new WirePayloadError(`event.${field}`));
  });

  it("throws on a required consent state given as null, and on one off its list", () => {
    expect(() => build({ consent: { analytics: null, ads: "denied" } })).toThrow(new WirePayloadError("event.consent.analytics"));
    expect(() => build({ consent: { analytics: "granted", ads: "yes" } })).toThrow(
      new WirePayloadError("event.consent.ads", "is not one of granted, denied, unknown, no_cmp"),
    );
  });

  it("throws on a client_ts that is NaN or infinite, rather than send it as JSON null", () => {
    for (const client_ts of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => build({ client_ts })).toThrow(new WirePayloadError("event.client_ts", "is not an integer"));
    }
  });

  it("leaves out an optional field given as null", () => {
    const event = build({ referrer: null, page_title: null, language: null, props: null });
    for (const field of ["referrer", "page_title", "language", "props"]) expect(event).not.toHaveProperty(field);
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
    const ping = buildPing({ ...pingInput(), referrer_host: null, utm: null } as unknown as PingInput);
    expect(ping).not.toHaveProperty("referrer_host");
    expect(ping).not.toHaveProperty("utm");
    expect(pingValidate(ping), JSON.stringify(pingValidate.errors)).toBe(true);
  });

  it("throws on an event_id or ping id that isn't a UUIDv7", () => {
    expect(() => buildEvent(eventInput(), "not-a-uuid")).toThrow(new WirePayloadError("event.event_id", `does not match ${TRACKED_EVENT_SHAPE.pattern.event_id}`));
    expect(() => buildPing(pingInput(), "00000000-0000-4000-8000-000000000000")).toThrow(
      new WirePayloadError("ping.event_id", `does not match ${WIRE_PING_SHAPE.pattern.event_id}`),
    );
  });
});

describe("compiledPattern (AAI-922)", () => {
  it("compiles a pattern once and gives back the same RegExp after", () => {
    const first = compiledPattern("^[a-z]+$");
    expect(first.flags).toBe("u");
    expect(compiledPattern("^[a-z]+$")).toBe(first);
  });

  it("compiles no pattern again when the next event is built", () => {
    buildEvent(purchaseInput());
    const spy = vi.spyOn(globalThis, "RegExp");
    try {
      buildEvent(purchaseInput());
      buildEvent(eventInput());
      buildPing(pingInput());
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("buildPing values (AAI-919)", () => {
  it("throws on a path that isn't a path, and on utm that isn't an object", () => {
    expect(() => buildPing({ ...pingInput(), path: "a/b" })).toThrow(new WirePayloadError("ping.path", "does not match ^/[^?#]*$"));
    expect(() => buildPing({ ...pingInput(), utm: "x" } as unknown as PingInput)).toThrow(
      new WirePayloadError("ping.utm", "is not an object"),
    );
  });
});

describe("STRIP_FROM (AAI-927)", () => {
  const pingValidate = validator("ping.json");
  const eventValidate = validator("event.json");

  it("names only string fields of the shapes", () => {
    const strings = (prefix: string, spec: Shape) =>
      Object.entries(spec.types).filter(([, type]) => type === "string").map(([field]) => `${prefix}.${field}`);
    const all = [...strings("event", TRACKED_EVENT_SHAPE), ...strings("event", PURCHASE_EVENT_SHAPE), ...strings("ping", WIRE_PING_SHAPE)];
    for (const at of Object.keys(STRIP_FROM)) expect(all).toContain(at);
  });

  it("cuts a string at the first of its characters", () => {
    expect(stripFrom("/a#b?c", "?#")).toBe("/a");
    expect(stripFrom("/a?b#c", "?#")).toBe("/a");
    expect(stripFrom("/a", "?#")).toBe("/a");
  });

  it("scrubs a ping's path of its query and fragment, so neither an email nor a token leaves without consent", () => {
    const ping = buildPing({ ...pingInput(), path: "/reset?email=victim@example.com&token=abc#frag" });
    expect(ping.path).toBe("/reset");
    expect(JSON.stringify(ping)).not.toContain("victim");
    expect(JSON.stringify(ping)).not.toContain("token");
    expect(pingValidate(ping), JSON.stringify(pingValidate.errors)).toBe(true);
    expect(buildPing({ ...pingInput(), path: "/callback#token=abc" }).path).toBe("/callback");
    expect(buildPing({ ...pingInput(), path: "/?q=1" }).path).toBe("/");
  });

  it("refuses a ping whose path is only a query, rather than send an empty path", () => {
    expect(() => buildPing({ ...pingInput(), path: "?email=victim@example.com" })).toThrow(new WirePayloadError("ping.path"));
  });

  it("refuses a whole URL given as the path, query and all", () => {
    expect(() => buildPing({ ...pingInput(), path: "https://a.example/reset?email=victim@example.com" })).toThrow(
      new WirePayloadError("ping.path", "does not match ^/[^?#]*$"),
    );
  });

  it.each(["https://mail.example/inbox?id=42", "mail.example/inbox", "victim@example.com", "mail.example:8080"])(
    "leaves out a referrer_host that isn't a bare hostname: %s",
    (referrer_host) => {
      const ping = buildPing({ ...pingInput(), referrer_host });
      expect(ping).not.toHaveProperty("referrer_host");
      expect(pingValidate(ping), JSON.stringify(pingValidate.errors)).toBe(true);
    },
  );

  it("keeps a bare referrer hostname", () => {
    expect(buildPing({ ...pingInput(), referrer_host: "mail.example" }).referrer_host).toBe("mail.example");
  });

  it("drops the fragment of an event's url and referrer, so an OAuth access token never leaves", () => {
    const event = buildEvent({
      ...eventInput(),
      url: "https://a.example/cb?utm_source=x#access_token=abc&state=1",
      referrer: "https://idp.example/auth?x=1#access_token=def",
    });
    expect(event.url).toBe("https://a.example/cb?utm_source=x");
    expect(event.referrer).toBe("https://idp.example/auth?x=1");
    expect(eventValidate(event), JSON.stringify(eventValidate.errors)).toBe(true);
  });

  it("leaves out a referrer that was only a fragment, and refuses such a url", () => {
    expect(buildEvent({ ...eventInput(), referrer: "#access_token=abc" })).not.toHaveProperty("referrer");
    expect(() => buildEvent({ ...eventInput(), url: "#access_token=abc" })).toThrow(new WirePayloadError("event.url"));
  });

  it("drops the fragment of a purchase's url too", () => {
    expect(buildEvent({ ...purchaseInput(), url: "https://a.example/thanks#access_token=abc" }).url).toBe("https://a.example/thanks");
  });
});
