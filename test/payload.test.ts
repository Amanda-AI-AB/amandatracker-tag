import { describe, expect, it } from "vitest";
import { PURCHASE_EVENT_SHAPE, TRACKED_EVENT_SHAPE, WIRE_PING_SHAPE } from "../src/wire/generated";
import {
  buildEvent,
  buildPing,
  cutSubtags,
  cutText,
  OVERFLOW,
  uuidv7,
  WirePayloadError,
  type EventInput,
  type PurchaseEventInput,
  type Shape,
  type PingInput,
  type TrackedEventInput,
} from "../src/wire/payload";
import { EVENT, PING, PURCHASE, validator } from "./wire-validator";

type Items = NonNullable<PurchaseEventInput["purchase"]["items"]>;

const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function eventInput(): TrackedEventInput {
  const { schema_version, event_id, ...input } = EVENT;
  return { ...input, consent: { ...input.consent }, props: { ...input.props } };
}

function purchaseInput(): PurchaseEventInput {
  const { schema_version, event_id, ...input } = PURCHASE;
  const items = input.purchase.items.map((item) => ({ ...item }));
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
  const shapes: [string, Shape][] = [["event", TRACKED_EVENT_SHAPE], ["event", PURCHASE_EVENT_SHAPE], ["ping", WIRE_PING_SHAPE]];

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
    const consent = { ...input.consent, functional: "granted" } as EventInput["consent"];
    const event = buildEvent({ ...input, consent });
    expect(Object.keys(event.consent).sort()).toEqual(["ads", "analytics"]);
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
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

  it("leaves out keys whose value is undefined, and props that end up empty", () => {
    expect(withProps({ plan: "pro", gone: undefined }).props).toEqual({ plan: "pro" });
    expect(withProps({ gone: undefined })).not.toHaveProperty("props");
    expect(withProps({})).not.toHaveProperty("props");
  });

  it("cuts a string over 200 characters on a whole character", () => {
    const event = withProps({ s: `${"x".repeat(199)}😀` });
    expect(event.props!.s).toBe("x".repeat(199));
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
    expect(() => withProps(["a"])).toThrow(new WirePayloadError("event.props", "is not a flat object"));
    expect(() => withProps("a")).toThrow(new WirePayloadError("event.props", "is not a flat object"));
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
    const event = buildEvent({ ...input, purchase: { ...input.purchase, items: [] } });
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
    const event = buildEvent(rest);
    expect(event).not.toHaveProperty("purchase");
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each(["order_id", "currency"] as const)("throws when the required %s is empty or missing", (field) => {
    const input = purchaseInput();
    expect(() => buildEvent({ ...input, purchase: { ...input.purchase, [field]: "" } })).toThrow(
      new WirePayloadError(`event.purchase.${field}`),
    );
  });

  it("throws on an item without a sku, naming the item", () => {
    const input = purchaseInput();
    const items = [{ ...PURCHASE.purchase.items[0] }, { qty: 1, price: 1 }] as Items;
    expect(() => buildEvent({ ...input, purchase: { ...input.purchase, items } })).toThrow(
      new WirePayloadError("event.purchase.items[1].sku"),
    );
  });

  it("throws on an order_id or sku over its cap, rather than send it as another one", () => {
    const input = purchaseInput();
    expect(() => buildEvent({ ...input, purchase: { ...input.purchase, order_id: "o".repeat(129) } })).toThrow(
      new WirePayloadError("event.purchase.order_id", "is over its cap of 128 characters"),
    );
    const items = [{ sku: "s".repeat(129), qty: 1, price: 1 }];
    expect(() => buildEvent({ ...input, purchase: { ...input.purchase, items } })).toThrow(
      new WirePayloadError("event.purchase.items[0].sku", "is over its cap of 128 characters"),
    );
  });

  it("cuts an item name over 200 characters", () => {
    const input = purchaseInput();
    const items = [{ sku: "a", name: "n".repeat(250), qty: 1, price: 1 }];
    const event = buildEvent({ ...input, purchase: { ...input.purchase, items } });
    expect(event).toHaveProperty("purchase.items.0.name", "n".repeat(200));
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
  });

  it("takes 50 items and throws on 51, rather than cut the order", () => {
    const input = purchaseInput();
    const items = (count: number) => Array.from({ length: count }, () => ({ sku: "a", qty: 1, price: 1 }));
    expect(validate(buildEvent({ ...input, purchase: { ...input.purchase, items: items(50) } }))).toBe(true);
    expect(() => buildEvent({ ...input, purchase: { ...input.purchase, items: items(51) } })).toThrow(
      new WirePayloadError("event.purchase.items", "has more than 50 items"),
    );
  });

  it("throws on an item that isn't an object", () => {
    const input = purchaseInput();
    const items = ["a"] as unknown as Items;
    expect(() => buildEvent({ ...input, purchase: { ...input.purchase, items } })).toThrow(
      new WirePayloadError("event.purchase.items[0]", "is not an object"),
    );
  });
});
