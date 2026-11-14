// The generated wire types refuse at compile time what the schema refuses at run time (AAI-934):
// each `@ts-expect-error` below fails `pnpm typecheck` when the type stops refusing its value, and
// each test checks that the schema refuses the same value.
import { describe, expect, it } from "vitest";
import type { WireBatch, WireEvent, WirePing } from "../src/wire/generated";
import { EVENT, PAGE_EXIT, PING, PURCHASE, validator } from "./wire-validator";

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
});
