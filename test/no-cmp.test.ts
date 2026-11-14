import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import { policyRequestInit } from "../src/core/endpoint";
import { fetchPolicyHint, PolicyError, resolveNoCmpPolicy } from "../src/core/no-cmp";

const ENDPOINT = "https://eu.serversider.com";

function boundary(): { boundary: ErrorBoundary; reports: ErrorReport[] } {
  const reports: ErrorReport[] = [];
  return { boundary: new ErrorBoundary((report) => reports.push(report), 1), reports };
}

function answering(status: number, json: () => unknown): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => json() }));
}

const asFetch = (fn: ReturnType<typeof vi.fn>): typeof fetch => fn as unknown as typeof fetch;

describe("fetchPolicyHint", () => {
  it.each(["granted", "denied"] as const)("asks GET /v1/policy without cookies, and returns %s", async (consent) => {
    const fetchFn = answering(200, () => ({ consent }));

    expect(await fetchPolicyHint(asFetch(fetchFn), ENDPOINT)).toBe(consent);
    expect(fetchFn).toHaveBeenCalledWith(`${ENDPOINT}/v1/policy`, policyRequestInit());
    expect(policyRequestInit()).toMatchObject({ credentials: "omit", referrerPolicy: "strict-origin" });
  });

  it("asks through a first-party proxy's endpoint", async () => {
    const fetchFn = answering(200, () => ({ consent: "denied" }));

    await fetchPolicyHint(asFetch(fetchFn), "https://www.example.com/amnda");
    expect(fetchFn).toHaveBeenCalledWith("https://www.example.com/amnda/v1/policy", policyRequestInit());
  });

  it.each([204, 404, 429, 500, 503])("rejects HTTP %i with PolicyError, naming the status", async (status) => {
    const error = await fetchPolicyHint(asFetch(answering(status, () => ({ consent: "granted" }))), ENDPOINT).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PolicyError);
    expect((error as PolicyError).status).toBe(status);
  });

  it.each([
    ["no consent", {}],
    ["another value", { consent: "yes" }],
    ["no_cmp", { consent: "no_cmp" }],
    ["null", null],
    ["a string", "granted"],
  ])("rejects a body with %s with PolicyError", async (_, body) => {
    await expect(fetchPolicyHint(asFetch(answering(200, () => body)), ENDPOINT)).rejects.toThrow(PolicyError);
  });

  it("rejects a body that isn't JSON with PolicyError", async () => {
    const fetchFn = answering(200, () => {
      throw new SyntaxError("Unexpected token <");
    });

    await expect(fetchPolicyHint(asFetch(fetchFn), ENDPOINT)).rejects.toThrow("the body is not JSON");
  });

  it("lets a network failure through as fetch's TypeError", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    await expect(fetchPolicyHint(asFetch(fetchFn), ENDPOINT)).rejects.toThrow(TypeError);
  });
});

describe("resolveNoCmpPolicy", () => {
  it("denies under assume_denied, without asking the collector", async () => {
    const fetchFn = answering(200, () => ({ consent: "granted" }));

    expect(await resolveNoCmpPolicy("assume_denied", asFetch(fetchFn), ENDPOINT, boundary().boundary)).toBe("denied");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("grants under assume_granted, without asking the collector", async () => {
    const fetchFn = answering(200, () => ({ consent: "denied" }));

    expect(await resolveNoCmpPolicy("assume_granted", asFetch(fetchFn), ENDPOINT, boundary().boundary)).toBe("granted");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each(["granted", "denied"] as const)("follows the collector's hint under geo: %s", async (consent) => {
    const { boundary: b, reports } = boundary();

    expect(await resolveNoCmpPolicy("geo", asFetch(answering(200, () => ({ consent }))), ENDPOINT, b)).toBe(consent);
    expect(reports).toEqual([]);
  });

  it("denies under geo when the collector rate limits, without reporting it", async () => {
    const { boundary: b, reports } = boundary();

    expect(await resolveNoCmpPolicy("geo", asFetch(answering(429, () => ({}))), ENDPOINT, b)).toBe("denied");
    expect(reports).toEqual([]);
  });

  it.each([
    ["a 5xx", answering(503, () => ({}))],
    ["a malformed body", answering(200, () => ({ consent: "maybe" }))],
    [
      "a network failure",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    ],
  ])("denies under geo on %s, and reports it", async (_, fetchFn) => {
    const { boundary: b, reports } = boundary();

    expect(await resolveNoCmpPolicy("geo", asFetch(fetchFn), ENDPOINT, b)).toBe("denied");
    expect(reports).toHaveLength(1);
    expect(reports[0]!.stage).toBe("consent");
  });
});
