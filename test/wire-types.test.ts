// The generated wire types refuse at compile time what the schema refuses at run time (AAI-934):
// each `@ts-expect-error` below fails `pnpm typecheck` when the type stops refusing its value, and
// each test checks that the schema refuses the same value.
import { describe, expect, it } from "vitest";
import type { PublishedTagError, PubSubMessage, WireBatch, WireEvent, WirePing } from "../src/wire/generated";
import { CLICK_SPECIAL, EVENT, PAGE_EXIT, PING, PURCHASE, UUID7, validator, WITHDRAWAL } from "./wire-validator";

const PAGE_ID = "3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b";

const batch = validator("batch.json");
const event = validator("event.json");
const ping = validator("ping.json");

describe("WireBatch", () => {
  it("takes a batch of events with its seq, and a batch of pings without one", () => {
    const events: WireBatch = { seq: 1, e: [EVENT] };
    const pings: WireBatch = { e: [PING] };
    expect(batch(events)).toBe(true);
    expect(batch(pings)).toBe(true);
  });

  it("refuses a seq beside a ping, which would link the pings (08 G2)", () => {
    // @ts-expect-error a PingBatch carries no seq
    const linked: WireBatch = { seq: 1, e: [PING] };
    expect(batch(linked)).toBe(false);
  });

  it("refuses a batch of events without its seq, which the loss count would miss (AAI-950)", () => {
    // @ts-expect-error an EventBatch always carries seq
    const unsequenced: WireBatch = { e: [EVENT] };
    expect(batch(unsequenced)).toBe(false);
  });

  it("refuses an empty batch", () => {
    // @ts-expect-error a batch holds 1 to 10 items
    const empty: WireBatch = { e: [] };
    expect(batch(empty)).toBe(false);
  });
});

describe("WireEvent and WirePing", () => {
  it("refuses a ping that carries an event's visitor_id", () => {
    // @ts-expect-error a ping has no visitor or session id
    const linked: WirePing = { ...PING, visitor_id: EVENT.visitor_id };
    expect(ping(linked)).toBe(false);
  });

  it("refuses a purchase on an event of any other type, and an empty item list", () => {
    // @ts-expect-error only a PurchaseEvent carries a purchase, and its type is purchase
    const tracked: WireEvent = { ...EVENT, purchase: PURCHASE.purchase };
    // @ts-expect-error an order's item list holds 1 to 50 items
    const noItems: WireEvent = { ...PURCHASE, purchase: { ...PURCHASE.purchase, items: [] } };
    expect(event(tracked)).toBe(false);
    expect(event(noItems)).toBe(false);
  });

  it("refuses an engagement time on an event of any other type, and on a ping (AAI-105)", () => {
    // @ts-expect-error only a PageExitEvent carries engagement_ms, and its type is page_exit
    const tracked: WireEvent = { ...EVENT, engagement_ms: PAGE_EXIT.engagement_ms };
    // @ts-expect-error a ping carries no engagement time
    const pinged: WirePing = { ...PING, engagement_ms: PAGE_EXIT.engagement_ms };
    expect(event(PAGE_EXIT)).toBe(true);
    expect(event(tracked)).toBe(false);
    expect(ping(pinged)).toBe(false);
  });

  it("refuses a link's scheme on an event of any other type, on a ping, and any scheme but tel and mailto (AAI-169)", () => {
    // @ts-expect-error only a ClickSpecialEvent carries link_scheme, and its type is click_special
    const tracked: WireEvent = { ...EVENT, link_scheme: CLICK_SPECIAL.link_scheme };
    // @ts-expect-error a ping carries no link's scheme
    const pinged: WirePing = { ...PING, link_scheme: CLICK_SPECIAL.link_scheme };
    // @ts-expect-error a link's scheme is tel or mailto, never its address
    const address: WireEvent = { ...CLICK_SPECIAL, link_scheme: "tel:+46701234567" };
    expect(event(CLICK_SPECIAL)).toBe(true);
    expect(event(tracked)).toBe(false);
    expect(ping(pinged)).toBe(false);
    expect(event(address)).toBe(false);
  });
});

describe("PubSubMessage (AAI-1142, AAI-1146)", () => {
  const message = validator("pubsub-message.json");
  const received = { schema_version: 1, received_at: 1, region: "europe-west1" } as const;
  const tagError: PublishedTagError = { schema_version: 1, event_id: UUID7, tag_version: "0.4.0", site_id: "site_123", stage: "boot", name: "TypeError" };

  it("takes a tag error without device_class, and an event with it", () => {
    const published: PubSubMessage = { ...received, event: tagError };
    const tracked: PubSubMessage = { ...received, device_class: "desktop", event: EVENT };
    expect(message(published)).toBe(true);
    expect(message(tracked)).toBe(true);
  });

  it("refuses device_class or geo on a tag error, its message, and an event without device_class", () => {
    // @ts-expect-error a tag error's message carries no user-agent field
    const withDevice: PubSubMessage = { ...received, device_class: "desktop", event: tagError };
    // @ts-expect-error a tag error's message carries no geo
    const withCountry: PubSubMessage = { ...received, country: "SE", event: tagError };
    // @ts-expect-error a published tag error never carries its message
    const withText: PubSubMessage = { ...received, event: { ...tagError, message: "boom" } };
    // @ts-expect-error every other message carries device_class
    const noDevice: PubSubMessage = { ...received, event: EVENT };
    for (const refused of [withDevice, withCountry, withText, noDevice]) expect(message(refused)).toBe(false);
  });

  it("takes seq and page_id on an event's message, and refuses them on any other (08 G2, AAI-1146)", () => {
    const tracked: PubSubMessage = { ...received, device_class: "desktop", seq: 3, page_id: PAGE_ID, event: EVENT };
    // @ts-expect-error a ping's message carries no seq, which would link the pings
    const pinged: PubSubMessage = { ...received, device_class: "desktop", seq: 3, event: PING };
    // @ts-expect-error a withdrawal signal's message carries no page_id
    const withdrawn: PubSubMessage = { ...received, device_class: "desktop", page_id: PAGE_ID, event: WITHDRAWAL };
    // @ts-expect-error a tag error's message carries no seq or page_id
    const published: PubSubMessage = { ...received, seq: 3, page_id: PAGE_ID, event: tagError };
    expect(message(tracked), JSON.stringify(message.errors)).toBe(true);
    for (const refused of [pinged, withdrawn, published]) expect(message(refused)).toBe(false);
  });

  it("takes the subdivision and the user-agent fields on an event's message only (06 §3, AAI-1148)", () => {
    const tracked: PubSubMessage = { ...received, device_class: "desktop", subdivision: "SE-AB", browser_family: "Chrome", browser_major: 131, os_family: "Windows", event: EVENT };
    // @ts-expect-error a ping's message carries country-level geo only
    const pinged: PubSubMessage = { ...received, device_class: "desktop", subdivision: "SE-AB", event: PING };
    // @ts-expect-error a ping's message carries no browser family
    const browsed: PubSubMessage = { ...received, device_class: "desktop", browser_family: "Chrome", event: PING };
    // @ts-expect-error a withdrawal signal's message carries no OS family
    const withdrawn: PubSubMessage = { ...received, device_class: "desktop", os_family: "Windows", event: WITHDRAWAL };
    // @ts-expect-error a withdrawal signal's message carries no browser major
    const versioned: PubSubMessage = { ...received, device_class: "desktop", browser_major: 131, event: WITHDRAWAL };
    const pingedCountry: PubSubMessage = { ...received, device_class: "desktop", country: "SE", event: PING };
    expect(message(tracked), JSON.stringify(message.errors)).toBe(true);
    expect(message(pingedCountry), JSON.stringify(message.errors)).toBe(true);
    for (const refused of [pinged, browsed, withdrawn, versioned]) expect(message(refused)).toBe(false);
  });
});
