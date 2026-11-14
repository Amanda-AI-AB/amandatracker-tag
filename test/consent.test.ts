import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkSignal,
  collectionMode,
  ConsentError,
  createConsent,
  initialConsent,
  MAX_PENDING,
  type Consent,
  type ConsentMachine,
  type ConsentState,
  type DeclinedMode,
} from "../src/core/consent";

/** What the machine handed over, in order, and what it did to the visitor's identity. */
type Out = ["identified", number, Consent] | ["anonymous", number] | ["withdraw"] | ["forget"] | ["renew"];

interface Harness {
  machine: ConsentMachine<number>;
  out: Out[];
}

function harness(declinedMode: DeclinedMode): Harness {
  const out: Out[] = [];
  const machine = createConsent<number>({
    declinedMode,
    sink: {
      identified: (item, consent) => out.push(["identified", item, consent]),
      anonymous: (item) => out.push(["anonymous", item]),
      withdraw: () => out.push(["withdraw"]),
    },
    identity: {
      forget: () => out.push(["forget"]),
      renew: () => out.push(["renew"]),
    },
  });
  return { machine, out };
}

const GRANTED: Consent = { analytics: "granted", ads: "granted" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("collectionMode", () => {
  it.each([
    ["granted", undefined, "identified"],
    ["denied", undefined, "declined"],
    ["unknown", undefined, "pending"],
    ["no_cmp", undefined, "pending"],
    ["no_cmp", "granted", "identified"],
    ["no_cmp", "denied", "declined"],
    ["granted", "denied", "identified"],
    ["denied", "granted", "declined"],
    ["unknown", "granted", "pending"],
  ] as const)("analytics %s, no-CMP decision %s: %s", (analytics, noCmp, mode) => {
    expect(collectionMode(analytics, noCmp)).toBe(mode);
  });
});

describe("checkSignal", () => {
  it("keeps the categories it names, and skips undefined ones", () => {
    expect(checkSignal({ analytics: "granted" })).toEqual({ analytics: "granted" });
    expect(checkSignal({ analytics: undefined, ads: "denied" })).toEqual({ ads: "denied" });
    expect(checkSignal({})).toEqual({});
  });

  it("refuses what isn't a signal, another category, or another state", () => {
    for (const signal of [null, "granted", [], 1]) expect(() => checkSignal(signal)).toThrow(ConsentError);
    expect(() => checkSignal({ functional: "granted" })).toThrow("unknown consent category: functional");
    for (const state of ["yes", true, null, "GRANTED"]) {
      expect(() => checkSignal({ analytics: state })).toThrow(ConsentError);
    }
  });
});

describe("the initial state", () => {
  it("is unknown in both categories, and pending", () => {
    const { machine, out } = harness("pings");
    expect(initialConsent()).toEqual({ analytics: "unknown", ads: "unknown" });
    expect(machine.snapshot()).toEqual({ analytics: "unknown", ads: "unknown" });
    expect(machine.mode()).toBe("pending");
    machine.collect(1);
    expect(machine.pendingCount()).toBe(1);
    expect(out).toEqual([]);
  });

  it("hands out a copy of the snapshot", () => {
    const { machine } = harness("off");
    machine.snapshot().analytics = "granted";
    expect(machine.snapshot().analytics).toBe("unknown");
  });
});

describe("granted", () => {
  it("collects with ids, under the snapshot of the moment", () => {
    const { machine, out } = harness("off");
    machine.update({ analytics: "granted", ads: "denied" });
    machine.collect(1);
    machine.update({ ads: "granted" });
    machine.collect(2);
    expect(machine.mode()).toBe("identified");
    expect(out).toEqual([
      ["identified", 1, { analytics: "granted", ads: "denied" }],
      ["identified", 2, GRANTED],
    ]);
  });

  it("is not changed by the ads category alone", () => {
    const { machine, out } = harness("off");
    machine.update({ analytics: "granted" });
    machine.update({ ads: "denied" });
    machine.update({ ads: "unknown" });
    expect(machine.mode()).toBe("identified");
    expect(out).toEqual([]);
  });
});

describe("denied", () => {
  it("sends pings in declined mode pings", () => {
    const { machine, out } = harness("pings");
    machine.update({ analytics: "denied", ads: "denied" });
    machine.collect(1);
    expect(machine.mode()).toBe("declined");
    expect(out).toEqual([["forget"], ["withdraw"], ["anonymous", 1]]);
  });

  it("sends nothing in declined mode off", () => {
    const { machine, out } = harness("off");
    machine.update({ analytics: "denied" });
    machine.collect(1);
    machine.collect(2);
    expect(out).toEqual([["forget"], ["withdraw"]]);
    expect(machine.pendingCount()).toBe(0);
  });

  it("forgets the visitor and withdraws unsent events once on entering, not on each signal", () => {
    const { machine, out } = harness("off");
    machine.update({ analytics: "denied" });
    machine.update({ analytics: "denied", ads: "granted" });
    expect(out).toEqual([["forget"], ["withdraw"]]);
  });
});

describe("unknown: the pending buffer", () => {
  it("flushes with ids on a grant, in order, under the granted snapshot", () => {
    const { machine, out } = harness("off");
    machine.collect(1);
    machine.collect(2);
    machine.update(GRANTED);
    expect(out).toEqual([
      ["identified", 1, GRANTED],
      ["identified", 2, GRANTED],
    ]);
    expect(machine.pendingCount()).toBe(0);
  });

  it("keeps the visitor's ids on a first grant: nothing was declined", () => {
    const { machine, out } = harness("off");
    machine.update(GRANTED);
    expect(out).not.toContainEqual(["renew"]);
  });

  it("flushes as pings on a denial in declined mode pings, after forgetting the visitor", () => {
    const { machine, out } = harness("pings");
    machine.collect(1);
    machine.collect(2);
    machine.update({ analytics: "denied" });
    expect(out).toEqual([["forget"], ["withdraw"], ["anonymous", 1], ["anonymous", 2]]);
    expect(machine.pendingCount()).toBe(0);
  });

  it("drops the buffer on a denial in declined mode off", () => {
    const { machine, out } = harness("off");
    machine.collect(1);
    machine.update({ analytics: "denied" });
    machine.update({ analytics: "granted" });
    expect(out).toEqual([["forget"], ["withdraw"], ["renew"]]);
    expect(machine.pendingCount()).toBe(0);
  });

  it("stays pending when only ads is decided", () => {
    const { machine, out } = harness("pings");
    machine.collect(1);
    machine.update({ ads: "granted" });
    expect(machine.mode()).toBe("pending");
    expect(machine.pendingCount()).toBe(1);
    expect(out).toEqual([]);
  });

  it(`holds at most ${MAX_PENDING} items, keeps the first ones, and warns once`, () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { machine, out } = harness("off");
    for (let i = 1; i <= MAX_PENDING + 5; i++) machine.collect(i);
    expect(machine.pendingCount()).toBe(MAX_PENDING);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(`${MAX_PENDING} items wait already`);
    machine.update({ analytics: "granted" });
    expect(out.map((entry) => entry[1])).toEqual(Array.from({ length: MAX_PENDING }, (_, i) => i + 1));
  });
});

describe("pagehide", () => {
  it("drops the buffer while still unknown in declined mode off", () => {
    const { machine, out } = harness("off");
    machine.collect(1);
    machine.collect(2);
    machine.pagehide();
    expect(out).toEqual([]);
    expect(machine.pendingCount()).toBe(0);
  });

  it("sends the buffer as pings while still unknown in declined mode pings", () => {
    const { machine, out } = harness("pings");
    machine.collect(1);
    machine.collect(2);
    machine.pagehide();
    expect(out).toEqual([
      ["anonymous", 1],
      ["anonymous", 2],
    ]);
  });

  it("neither forgets the visitor nor changes the state: nothing was decided", () => {
    const { machine, out } = harness("pings");
    machine.collect(1);
    machine.pagehide();
    expect(out).not.toContainEqual(["forget"]);
    expect(machine.snapshot()).toEqual(initialConsent());
    expect(machine.mode()).toBe("pending");
    // A page restored from the back-forward cache buffers again, and a grant sends what came after.
    machine.collect(2);
    machine.update({ analytics: "granted" });
    expect(out).toEqual([
      ["anonymous", 1],
      ["identified", 2, { analytics: "granted", ads: "unknown" }],
    ]);
  });

  it("does nothing once the state is decided", () => {
    const { machine, out } = harness("pings");
    machine.update({ analytics: "granted" });
    machine.pagehide();
    expect(out).toEqual([]);
  });
});

describe("mid-session changes", () => {
  it("deny -> grant renews the ids: pings sent before are never linked to the visitor", () => {
    const { machine, out } = harness("pings");
    machine.update({ analytics: "denied" });
    machine.collect(1);
    machine.update({ analytics: "granted" });
    machine.collect(2);
    expect(out).toEqual([["forget"], ["withdraw"], ["anonymous", 1], ["renew"], ["identified", 2, { analytics: "granted", ads: "unknown" }]]);
  });

  it("grant -> deny forgets the visitor at once and switches to the declined mode", () => {
    const { machine, out } = harness("pings");
    machine.update(GRANTED);
    machine.collect(1);
    machine.update({ analytics: "denied" });
    machine.collect(2);
    expect(out).toEqual([["identified", 1, GRANTED], ["forget"], ["withdraw"], ["anonymous", 2]]);
  });

  it("grant -> deny in declined mode off withdraws the events not sent yet, and sends nothing more", () => {
    const { machine, out } = harness("off");
    machine.update(GRANTED);
    machine.update({ analytics: "denied" });
    machine.collect(1);
    expect(out).toEqual([["forget"], ["withdraw"]]);
  });

  it("renews the ids on every grant that follows a denial", () => {
    const { machine, out } = harness("off");
    machine.update({ analytics: "granted" });
    machine.update({ analytics: "denied" });
    machine.update({ analytics: "granted" });
    machine.update({ analytics: "denied" });
    machine.update({ analytics: "granted" });
    expect(out).toEqual([["forget"], ["withdraw"], ["renew"], ["forget"], ["withdraw"], ["renew"]]);
  });

  it("deny -> unknown buffers again, and a grant then renews the ids", () => {
    const { machine, out } = harness("off");
    machine.update({ analytics: "denied" });
    machine.update({ analytics: "unknown" });
    machine.collect(1);
    expect(machine.pendingCount()).toBe(1);
    machine.update({ analytics: "granted" });
    expect(out).toEqual([["forget"], ["withdraw"], ["renew"], ["identified", 1, { analytics: "granted", ads: "unknown" }]]);
  });

  it("grant -> unknown buffers, and keeps the ids", () => {
    const { machine, out } = harness("off");
    machine.update({ analytics: "granted" });
    machine.update({ analytics: "unknown" });
    machine.collect(1);
    machine.pagehide();
    expect(out).toEqual([]);
  });
});

describe("no_cmp", () => {
  it("waits for the no-CMP policy, and never assumes a decision", () => {
    const { machine, out } = harness("pings");
    machine.update({ analytics: "no_cmp", ads: "no_cmp" });
    machine.collect(1);
    expect(machine.mode()).toBe("pending");
    expect(out).toEqual([]);
  });

  it("collects with ids once the policy grants, under the no_cmp snapshot", () => {
    const { machine, out } = harness("off");
    machine.update({ analytics: "no_cmp", ads: "no_cmp" });
    machine.collect(1);
    machine.resolveNoCmp("granted");
    machine.collect(2);
    const snapshot = { analytics: "no_cmp", ads: "no_cmp" };
    expect(out).toEqual([
      ["identified", 1, snapshot],
      ["identified", 2, snapshot],
    ]);
  });

  it("follows the declined mode once the policy denies", () => {
    const { machine, out } = harness("pings");
    machine.update({ analytics: "no_cmp" });
    machine.collect(1);
    machine.resolveNoCmp("denied");
    machine.collect(2);
    expect(out).toEqual([["forget"], ["withdraw"], ["anonymous", 1], ["anonymous", 2]]);
  });

  it("drops the buffer on pagehide in declined mode off while the policy hasn't answered", () => {
    const { machine, out } = harness("off");
    machine.update({ analytics: "no_cmp" });
    machine.collect(1);
    machine.pagehide();
    expect(out).toEqual([]);
    expect(machine.pendingCount()).toBe(0);
  });

  it("applies a decision given before the state is no_cmp once it is", () => {
    const { machine } = harness("off");
    machine.resolveNoCmp("granted");
    expect(machine.mode()).toBe("pending");
    machine.update({ analytics: "no_cmp" });
    expect(machine.mode()).toBe("identified");
  });

  it("gives way to a consent manager's signal", () => {
    const { machine, out } = harness("off");
    machine.update({ analytics: "no_cmp" });
    machine.resolveNoCmp("granted");
    machine.update({ analytics: "denied" });
    expect(machine.mode()).toBe("declined");
    expect(out).toEqual([["forget"], ["withdraw"]]);
  });

  it("refuses a decision other than granted or denied", () => {
    const { machine } = harness("off");
    expect(() => machine.resolveNoCmp("unknown" as "granted")).toThrow(ConsentError);
  });
});

describe("a refused signal", () => {
  it("changes nothing", () => {
    const { machine, out } = harness("pings");
    machine.collect(1);
    expect(() => machine.update({ analytics: "denied", ads: "maybe" as ConsentState })).toThrow(ConsentError);
    expect(machine.snapshot()).toEqual(initialConsent());
    expect(machine.pendingCount()).toBe(1);
    expect(out).toEqual([]);
  });

  it("changes nothing for a source off the list", () => {
    const { machine } = harness("off");
    expect(() => machine.update({ analytics: "granted" }, "tcf" as "gcm")).toThrow(ConsentError);
    expect(machine.snapshot()).toEqual(initialConsent());
  });
});

describe("the snapshot's source", () => {
  it("names the source of the signal applied, and follows a change of source", () => {
    const { machine, out } = harness("off");
    machine.update({ analytics: "granted" }, "gcm");
    machine.collect(1);
    machine.update({ ads: "denied" }, "manual");
    machine.collect(2);
    expect(out).toEqual([
      ["identified", 1, { analytics: "granted", ads: "unknown", source: "gcm" }],
      ["identified", 2, { analytics: "granted", ads: "denied", source: "manual" }],
    ]);
  });

  it("is absent until a source signals, and kept by a no-CMP decision", () => {
    const { machine } = harness("off");
    expect(machine.snapshot().source).toBeUndefined();
    machine.update({ analytics: "no_cmp" }, "gcm");
    machine.resolveNoCmp("granted");
    expect(machine.snapshot()).toEqual({ analytics: "no_cmp", ads: "unknown", source: "gcm" });
  });
});
