import { describe, expect, it, vi } from "vitest";
import { checkSiteId, ConfigError, declinedMode, errorSampleRate, fetchConfig, gpcHonored, parseConfig } from "../src/core/config";
import { configRequestInit } from "../src/core/endpoint";

const CONFIG = { schema_version: 1, site: "site_123", config_version: 3, paused: false };

describe("checkSiteId", () => {
  it("accepts a site id, trimmed", () => {
    expect(checkSiteId("site_123")).toBe("site_123");
    expect(checkSiteId(" A-b_9 ")).toBe("A-b_9");
  });

  it("refuses a missing, empty, too long or malformed one", () => {
    for (const value of [null, undefined, "", " ", "x".repeat(65), "site/../other", "site?x=1", "site.json"]) {
      expect(() => checkSiteId(value)).toThrow(ConfigError);
    }
  });
});

describe("parseConfig", () => {
  it("accepts the publisher's layout and keeps every section", () => {
    expect(parseConfig(CONFIG, "site_123")).toEqual(CONFIG);
  });

  it("refuses what isn't a config object", () => {
    for (const json of [null, [], "x", 1]) {
      expect(() => parseConfig(json, "site_123")).toThrow("not a JSON object");
    }
  });

  it("refuses another layout, another site, or a missing config_version", () => {
    expect(() => parseConfig({ ...CONFIG, schema_version: 2 }, "site_123")).toThrow("schema_version is 2");
    expect(() => parseConfig({ ...CONFIG, site: "other" }, "site_123")).toThrow("for site other");
    for (const config_version of [undefined, "3", -1, 1.5]) {
      expect(() => parseConfig({ ...CONFIG, config_version }, "site_123")).toThrow("config_version");
    }
  });
});

describe("the telemetry section", () => {
  it("is optional, and sets the error sample rate", () => {
    expect(errorSampleRate(parseConfig(CONFIG, "site_123"))).toBeUndefined();
    expect(errorSampleRate(parseConfig({ ...CONFIG, telemetry: {} }, "site_123"))).toBeUndefined();
    for (const rate of [0, 0.25, 1]) {
      expect(errorSampleRate(parseConfig({ ...CONFIG, telemetry: { error_sample_rate: rate } }, "site_123"))).toBe(rate);
    }
  });

  it("refuses a section or a rate of another shape", () => {
    for (const telemetry of [null, [], "x", { error_sample_rate: 1.5 }, { error_sample_rate: -0.1 }, { error_sample_rate: "0.5" }]) {
      expect(() => parseConfig({ ...CONFIG, telemetry }, "site_123")).toThrow(ConfigError);
    }
  });
});

describe("the consent section", () => {
  it("is optional, and sets the declined mode, off by default", () => {
    expect(declinedMode(parseConfig(CONFIG, "site_123"))).toBe("off");
    expect(declinedMode(parseConfig({ ...CONFIG, consent: {} }, "site_123"))).toBe("off");
    expect(declinedMode(parseConfig({ ...CONFIG, consent: { declined_mode: "off" } }, "site_123"))).toBe("off");
    expect(declinedMode(parseConfig({ ...CONFIG, consent: { declined_mode: "pings" } }, "site_123"))).toBe("pings");
  });

  it("honors GPC unless the site turns it off", () => {
    expect(gpcHonored(parseConfig(CONFIG, "site_123"))).toBe(true);
    expect(gpcHonored(parseConfig({ ...CONFIG, consent: {} }, "site_123"))).toBe(true);
    expect(gpcHonored(parseConfig({ ...CONFIG, consent: { gpc_honored: true } }, "site_123"))).toBe(true);
    expect(gpcHonored(parseConfig({ ...CONFIG, consent: { gpc_honored: false } }, "site_123"))).toBe(false);
  });

  it("refuses a GPC toggle that isn't a boolean", () => {
    for (const gpc_honored of [null, 0, 1, "false", "true", {}]) {
      expect(() => parseConfig({ ...CONFIG, consent: { gpc_honored } }, "site_123")).toThrow(ConfigError);
    }
  });

  it("keeps the section's other fields for the tickets that read them", () => {
    const consent = { declined_mode: "pings", no_cmp_policy: "geo", gpc_honored: true };
    expect(parseConfig({ ...CONFIG, consent }, "site_123").consent).toEqual(consent);
  });

  it("refuses a section or a declined mode of another shape", () => {
    for (const consent of [null, [], "pings", { declined_mode: "on" }, { declined_mode: "" }, { declined_mode: null }, { declined_mode: 1 }]) {
      expect(() => parseConfig({ ...CONFIG, consent }, "site_123")).toThrow(ConfigError);
    }
  });
});

describe("fetchConfig", () => {
  it("fetches cfg/<site>.json without cookies", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => CONFIG }));

    expect(await fetchConfig(fetchFn as unknown as typeof fetch, "https://eu.serversider.com", "site_123")).toEqual(CONFIG);
    expect(fetchFn).toHaveBeenCalledWith("https://eu.serversider.com/cfg/site_123.json", configRequestInit());
  });

  it("rejects with ConfigError for an HTTP error or a body that isn't JSON", async () => {
    const notFound = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    const html = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => JSON.parse("<html>"),
    }));

    await expect(fetchConfig(notFound as unknown as typeof fetch, "https://e.example", "s")).rejects.toThrow("HTTP 404");
    await expect(fetchConfig(html as unknown as typeof fetch, "https://e.example", "s")).rejects.toThrow("not JSON");
  });
});
