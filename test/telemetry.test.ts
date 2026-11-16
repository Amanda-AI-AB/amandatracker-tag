import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ENDPOINT, REFERRER_POLICY, tagErrorRequestInit, tagErrorsUrl } from "../src/core/endpoint";
import { defaultTarget, ERROR_SAMPLE_RATE, tagErrorSink } from "../src/core/telemetry";
import { buildTagError, scrubMessage } from "../src/wire/payload";
import { validator } from "./wire-validator";

const validate = validator("tag-error.json");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tag-error.json", () => {
  it("accepts a built tag error, with or without its site and message", () => {
    for (const input of [
      { tag_version: "0.2.0", site_id: "site_123", stage: "config", name: "ConfigError", message: "HTTP 404" },
      { tag_version: "0.2.0", stage: "boot", name: "ConfigError" },
    ] as const) {
      const report = buildTagError(input);
      expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it("refuses anything about the visitor or the page", () => {
    const report = buildTagError({ tag_version: "0.2.0", stage: "boot", name: "Error" });
    for (const extra of [{ url: "https://shop.example/" }, { visitor_id: report.event_id }, { client_ts: 1 }]) {
      expect(validate({ ...report, ...extra })).toBe(false);
    }
  });
});

describe("buildTagError", () => {
  it("rounds its event_id's time to the hour, as a ping's", () => {
    const report = buildTagError({ tag_version: "0.2.0", stage: "boot", name: "Error" });
    const ms = parseInt(report.event_id.replace(/-/g, "").slice(0, 12), 16);
    expect(ms % 3_600_000).toBe(0);
  });

  it("scrubs and caps the message, and caps the name", () => {
    const report = buildTagError({
      tag_version: "0.2.0",
      stage: "boot",
      name: "N".repeat(100),
      message: `a relative data-endpoint cannot resolve against https://shop.example/reset?token=abc#x for ann@example.com ${"x".repeat(400)}`,
    });
    expect(report.name).toHaveLength(64);
    expect(report.message).toMatch(/^a relative data-endpoint cannot resolve against https:\/\/shop\.example for <email> x+$/);
    expect(report.message).toHaveLength(256);
    expect(validate(report)).toBe(true);
  });

  it("leaves out an empty message, and refuses a stage the schema doesn't list", () => {
    expect(buildTagError({ tag_version: "0.2.0", stage: "boot", name: "Error", message: "" })).not.toHaveProperty("message");
    expect(() => buildTagError({ tag_version: "0.2.0", stage: "unload" as "boot", name: "Error" })).toThrow("tag_error.stage");
  });
});

describe("scrubMessage", () => {
  it("cuts each URL to its scheme and host", () => {
    expect(scrubMessage("GET https://eu.serversider.com/cfg/s.json: HTTP 404")).toBe("GET https://eu.serversider.com HTTP 404");
    expect(scrubMessage("from http://localhost:8080/a?b=c and blob:x")).toBe("from http://localhost:8080 and blob:x");
  });

  it("replaces email addresses, credentials in a URL included", () => {
    expect(scrubMessage("user ann.b+x@shop.example.se signed in")).toBe("user <email> signed in");
    expect(scrubMessage("at https://ann:pw@shop.example/x")).toBe("at <email>");
  });
});

describe("tagErrorSink", () => {
  const REPORT = { stage: "config", name: "ConfigError", message: "GET https://eu.serversider.com/cfg/s.json: HTTP 404" } as const;

  it("posts each report without cookies to the target's /v1/t, with the site once the boot knows it", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 204 }));
    const target = defaultTarget();
    const sink = tagErrorSink(fetchFn as unknown as typeof fetch, "0.2.0", target);

    sink(REPORT);
    target.endpoint = "https://shop.example/amnda";
    target.site = "site_123";
    sink(REPORT);

    expect(fetchFn.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      `${DEFAULT_ENDPOINT}/v1/t`,
      "https://shop.example/amnda/v1/t",
    ]);
    const [first, second] = fetchFn.mock.calls.map((call) => JSON.parse(((call as unknown[])[1] as RequestInit).body as string));
    expect(first).not.toHaveProperty("site_id");
    expect(second).toMatchObject({ tag_version: "0.2.0", site_id: "site_123", stage: "config", name: "ConfigError" });
    expect(second.message).toBe("GET https://eu.serversider.com HTTP 404");
    expect(validate(second)).toBe(true);
    expect((fetchFn.mock.calls[0] as unknown[])[1]).toMatchObject({ method: "POST", credentials: "omit", referrerPolicy: REFERRER_POLICY });
  });

  it("logs, and never throws or reports again, when the post fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failing = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const refused = vi.fn(async () => ({ ok: false, status: 400 }));

    tagErrorSink(failing as unknown as typeof fetch, "0.2.0", defaultTarget())(REPORT);
    tagErrorSink(refused as unknown as typeof fetch, "0.2.0", defaultTarget())(REPORT);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(warn).toHaveBeenCalledWith(`amanda: POST ${DEFAULT_ENDPOINT}/v1/t failed`, REPORT, expect.any(TypeError));
    expect(warn).toHaveBeenCalledWith(`amanda: POST ${DEFAULT_ENDPOINT}/v1/t: HTTP 400`, REPORT);
  });
});

describe("the request", () => {
  it("goes to /v1/t as a POST without cookies, and samples 10 % of pages by default", () => {
    expect(tagErrorsUrl("https://shop.example/amnda")).toBe("https://shop.example/amnda/v1/t");
    expect(tagErrorRequestInit("{}")).toEqual({ method: "POST", body: "{}", credentials: "omit", referrerPolicy: REFERRER_POLICY });
    expect(ERROR_SAMPLE_RATE).toBe(0.1);
  });
});
