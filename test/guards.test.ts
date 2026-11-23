import { describe, expect, it } from "vitest";
import { isRecord } from "../src/core/guards";

describe("isRecord", () => {
  it("takes an object, its prototype whatever it is", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    expect(isRecord(new Date())).toBe(true);
  });

  it("refuses null, arrays and every primitive", () => {
    for (const value of [null, undefined, [], [1], "x", 0, true, Symbol("s"), ()=> undefined]) {
      expect(isRecord(value)).toBe(false);
    }
  });
});
