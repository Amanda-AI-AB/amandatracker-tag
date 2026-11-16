import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary, MAX_REPORTS_PER_PAGE, type ErrorReport } from "../src/core/boundary";

afterEach(() => {
  vi.restoreAllMocks();
});

function boundary(sampleRate = 1, random = () => 0.5) {
  const reports: ErrorReport[] = [];
  return { reports, boundary: new ErrorBoundary((report) => reports.push(report), sampleRate, random) };
}

describe("ErrorBoundary", () => {
  it("returns what the guarded function returns", () => {
    expect(boundary().boundary.guard("boot", () => 42)).toBe(42);
  });

  it("reports what the guarded function throws instead of throwing it", () => {
    const { reports, boundary: b } = boundary();

    expect(b.guard("command", () => {
      throw new RangeError("bad");
    })).toBeUndefined();
    b.guard("boot", () => {
      throw "a string";
    });

    expect(reports).toEqual([
      { stage: "command", name: "RangeError", message: "bad" },
      { stage: "boot", name: "string", message: "a string" },
    ]);
  });

  it("reports a rejected promise it watches", async () => {
    const { reports, boundary: b } = boundary();

    b.watch("config", Promise.reject(new Error("offline")));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reports).toEqual([{ stage: "config", name: "Error", message: "offline" }]);
  });

  it("draws the page once: a sampled page reports, any other reports nothing", () => {
    const random = vi.fn(() => 0.05);
    const sampled = boundary(0.1, random);
    const unsampled = boundary(0.1, () => 0.5);

    for (const b of [sampled.boundary, unsampled.boundary]) {
      b.report("boot", new Error("one"));
      b.report("boot", new Error("two"));
    }

    expect(random).toHaveBeenCalledTimes(1);
    expect(sampled.reports).toHaveLength(2);
    expect(unsampled.reports).toEqual([]);
  });

  it("reports nothing at a sample rate of 0", () => {
    const { reports, boundary: b } = boundary(0, () => 0);
    b.report("boot", new Error("x"));
    expect(reports).toEqual([]);
  });

  it("caps the reports of a page", () => {
    const { reports, boundary: b } = boundary();
    for (let i = 0; i < MAX_REPORTS_PER_PAGE + 3; i++) b.report("route", new Error(String(i)));
    expect(reports).toHaveLength(MAX_REPORTS_PER_PAGE);
  });

  it("applies a new sample rate to the failures still to come, with the page's one draw", () => {
    const random = vi.fn(() => 0.3);
    const { reports, boundary: b } = boundary(0.1, random);

    b.report("boot", new Error("before the config"));
    b.setSampleRate(0.5);
    b.report("command", new Error("after it"));
    b.setSampleRate(0);
    b.report("route", new Error("sampling turned off"));

    expect(random).toHaveBeenCalledTimes(1);
    expect(reports.map((r) => r.message)).toEqual(["after it"]);
  });

  it("names an Error without a name Error", () => {
    const { reports, boundary: b } = boundary();
    const error = new Error("x");
    error.name = "";
    b.report("boot", error);
    expect(reports[0]!.name).toBe("Error");
  });

  it("logs, and never throws, when its sink throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const b = new ErrorBoundary(() => {
      throw new Error("sink down");
    }, 1);

    expect(() => b.guard("boot", () => {
      throw new Error("tag bug");
    })).not.toThrow();

    expect(warn).toHaveBeenCalledWith(
      "amanda: could not report a tag error",
      { stage: "boot", name: "Error", message: "tag bug" },
      expect.objectContaining({ message: "sink down" }),
    );
  });
});
