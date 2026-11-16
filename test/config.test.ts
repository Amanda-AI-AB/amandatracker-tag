import { describe, expect, it, vi } from "vitest";
import {
  bundleVersion,
  checkSiteId,
  ConfigError,
  customParams,
  declinedMode,
  errorSampleRate,
  fetchConfig,
  ga4EcommerceEnabled,
  gpcHonored,
  hasCmp,
  MAX_CUSTOM_PARAMS,
  noCmpPolicy,
  outboundClicksEnabled,
  ownDomains,
  parseConfig,
  paused,
  pingsIncludeClickIds,
  purgeOnWithdrawal,
} from "../src/core/config";
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

describe("paused, the kill switch", () => {
  it("is optional, off when the site sets none", () => {
    expect(paused(parseConfig(CONFIG, "site_123"))).toBe(false);
    expect(paused(parseConfig({ schema_version: 1, site: "site_123", config_version: 3 }, "site_123"))).toBe(false);
    expect(paused(parseConfig({ ...CONFIG, paused: true }, "site_123"))).toBe(true);
  });

  it("refuses a flag that isn't a boolean", () => {
    for (const value of [null, 0, 1, "true", "false", {}, []]) {
      expect(() => parseConfig({ ...CONFIG, paused: value }, "site_123")).toThrow(ConfigError);
    }
  });
});

describe("domains, the site's own (AAI-167)", () => {
  const parse = (domains: unknown) => parseConfig({ ...CONFIG, domains }, "site_123");

  it("is optional: none when the site sets none", () => {
    expect(ownDomains(parseConfig(CONFIG, "site_123"))).toEqual([]);
    expect(ownDomains(parse([]))).toEqual([]);
  });

  it("reads each as a browser reads a link's hostname: lower case, punycode, no trailing dot", () => {
    expect(ownDomains(parse(["example.de", "Shop.Example.COM.", "bücher.de", "192.0.2.1"]))).toEqual([
      "example.de",
      "shop.example.com",
      "xn--bcher-kva.de",
      "192.0.2.1",
    ]);
  });

  it("keeps the config's own value as the publisher wrote it", () => {
    expect(parse(["Shop.Example.COM."]).domains).toEqual(["Shop.Example.COM."]);
  });

  it("refuses a list that isn't one, or a value that isn't a hostname", () => {
    for (const domains of [null, "example.de", { a: "example.de" }]) expect(() => parse(domains)).toThrow("domains is not a list");
    for (const domain of ["", " ", 1, null, "https://example.de", "example.de/shop", "example.de:8080", "user@example.de", "exa mple.de", "[::1]", "a..b", "odd$host.example"]) {
      expect(() => parse([domain]), JSON.stringify(domain)).toThrow("not a hostname");
    }
  });
});

describe("features.outbound_clicks_enabled (AAI-167)", () => {
  it("is on when the site sets none, and off only when it says false", () => {
    expect(outboundClicksEnabled(parseConfig(CONFIG, "site_123"))).toBe(true);
    expect(outboundClicksEnabled(parseConfig({ ...CONFIG, features: {} }, "site_123"))).toBe(true);
    expect(outboundClicksEnabled(parseConfig({ ...CONFIG, features: { outbound_clicks_enabled: true } }, "site_123"))).toBe(true);
    expect(outboundClicksEnabled(parseConfig({ ...CONFIG, features: { outbound_clicks_enabled: false } }, "site_123"))).toBe(false);
  });

  it("refuses a toggle that isn't a boolean", () => {
    for (const value of [null, 0, 1, "false", {}]) {
      expect(() => parseConfig({ ...CONFIG, features: { outbound_clicks_enabled: value } }, "site_123")).toThrow(
        "features.outbound_clicks_enabled is not a boolean",
      );
    }
  });
});

describe("features.ga4_ecommerce_enabled (AAI-974)", () => {
  it("is off when the site sets none, and on only when it says true", () => {
    expect(ga4EcommerceEnabled(parseConfig(CONFIG, "site_123"))).toBe(false);
    expect(ga4EcommerceEnabled(parseConfig({ ...CONFIG, features: {} }, "site_123"))).toBe(false);
    expect(ga4EcommerceEnabled(parseConfig({ ...CONFIG, features: { ga4_ecommerce_enabled: false } }, "site_123"))).toBe(false);
    expect(ga4EcommerceEnabled(parseConfig({ ...CONFIG, features: { ga4_ecommerce_enabled: true } }, "site_123"))).toBe(true);
  });

  it("refuses a toggle that isn't a boolean", () => {
    for (const value of [null, 0, 1, "true", {}]) {
      expect(() => parseConfig({ ...CONFIG, features: { ga4_ecommerce_enabled: value } }, "site_123")).toThrow(
        new ConfigError(`the config's features.ga4_ecommerce_enabled is not a boolean: ${String(value)}`),
      );
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

  it("reads the no-CMP policy, geo when the site sets none", () => {
    expect(noCmpPolicy(parseConfig(CONFIG, "site_123"))).toBe("geo");
    expect(noCmpPolicy(parseConfig({ ...CONFIG, consent: {} }, "site_123"))).toBe("geo");
    for (const no_cmp_policy of ["geo", "assume_denied", "assume_granted"] as const) {
      expect(noCmpPolicy(parseConfig({ ...CONFIG, consent: { no_cmp_policy } }, "site_123"))).toBe(no_cmp_policy);
    }
  });

  it("reads whether the site has a consent manager, yes when it sets nothing", () => {
    expect(hasCmp(parseConfig(CONFIG, "site_123"))).toBe(true);
    expect(hasCmp(parseConfig({ ...CONFIG, consent: {} }, "site_123"))).toBe(true);
    expect(hasCmp(parseConfig({ ...CONFIG, consent: { has_cmp: true } }, "site_123"))).toBe(true);
    expect(hasCmp(parseConfig({ ...CONFIG, consent: { has_cmp: false } }, "site_123"))).toBe(false);
  });

  it("refuses a has_cmp that isn't a boolean", () => {
    for (const has_cmp of [null, 0, "false", "none", {}]) {
      expect(() => parseConfig({ ...CONFIG, consent: { has_cmp } }, "site_123")).toThrow(ConfigError);
    }
  });

  it("refuses a no-CMP policy off the list", () => {
    for (const no_cmp_policy of [null, "", "assume-granted", "granted", "GEO", 1, {}]) {
      expect(() => parseConfig({ ...CONFIG, consent: { no_cmp_policy } }, "site_123")).toThrow(ConfigError);
    }
  });

  it("leaves click IDs out of pings unless the site turns pings_include_click_ids on", () => {
    expect(pingsIncludeClickIds(parseConfig(CONFIG, "site_123"))).toBe(false);
    expect(pingsIncludeClickIds(parseConfig({ ...CONFIG, consent: {} }, "site_123"))).toBe(false);
    expect(pingsIncludeClickIds(parseConfig({ ...CONFIG, consent: { pings_include_click_ids: false } }, "site_123"))).toBe(false);
    expect(pingsIncludeClickIds(parseConfig({ ...CONFIG, consent: { pings_include_click_ids: true } }, "site_123"))).toBe(true);
  });

  it("refuses a pings_include_click_ids that isn't a boolean", () => {
    for (const pings_include_click_ids of [null, 0, 1, "true", "false", {}]) {
      expect(() => parseConfig({ ...CONFIG, consent: { pings_include_click_ids } }, "site_123")).toThrow(ConfigError);
    }
  });

  it("purges on withdrawal only when the site turns purge_on_withdrawal on (AAI-785)", () => {
    expect(purgeOnWithdrawal(parseConfig(CONFIG, "site_123"))).toBe(false);
    expect(purgeOnWithdrawal(parseConfig({ ...CONFIG, consent: {} }, "site_123"))).toBe(false);
    expect(purgeOnWithdrawal(parseConfig({ ...CONFIG, consent: { purge_on_withdrawal: false } }, "site_123"))).toBe(false);
    expect(purgeOnWithdrawal(parseConfig({ ...CONFIG, consent: { purge_on_withdrawal: true } }, "site_123"))).toBe(true);
  });

  it("refuses a purge_on_withdrawal that isn't a boolean", () => {
    for (const purge_on_withdrawal of [null, 0, 1, "true", "false", {}]) {
      expect(() => parseConfig({ ...CONFIG, consent: { purge_on_withdrawal } }, "site_123")).toThrow(ConfigError);
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

describe("custom_params", () => {
  it("is optional, and names the site's own attribution parameters", () => {
    expect(customParams(parseConfig(CONFIG, "site_123"))).toEqual([]);
    expect(customParams(parseConfig({ ...CONFIG, custom_params: [] }, "site_123"))).toEqual([]);
    expect(customParams(parseConfig({ ...CONFIG, custom_params: ["ref", "Partner ID"] }, "site_123"))).toEqual(["ref", "Partner ID"]);
    const most = Array.from({ length: MAX_CUSTOM_PARAMS }, (_, i) => `p${i}`);
    expect(customParams(parseConfig({ ...CONFIG, custom_params: most }, "site_123"))).toEqual(most);
  });

  it("refuses what isn't a list of names, or more names than an event can carry", () => {
    const tooMany = Array.from({ length: MAX_CUSTOM_PARAMS + 1 }, (_, i) => `p${i}`);
    for (const custom_params of [null, "ref", { ref: true }, [""], ["ref", 1], [null], tooMany]) {
      expect(() => parseConfig({ ...CONFIG, custom_params }, "site_123")).toThrow(ConfigError);
    }
  });
});

describe("bundle_version", () => {
  it("is optional, and names the build the site is pinned to", () => {
    expect(bundleVersion(parseConfig(CONFIG, "site_123"))).toBeUndefined();
    for (const bundle_version of ["0.3.0", "0.3.1-dev.20261114103000.gabc1234", "1.0.0-canary.1+b7"]) {
      expect(bundleVersion(parseConfig({ ...CONFIG, bundle_version }, "site_123"))).toBe(bundle_version);
    }
  });

  it("refuses anything but a tag version", () => {
    const tooLong = `1.0.0-${"x".repeat(59)}`;
    for (const bundle_version of [null, "", "latest", "v0.3.0", "0.3", "../a", "0.3.0/x", "0.3.0 ", 3, {}, tooLong]) {
      expect(() => parseConfig({ ...CONFIG, bundle_version }, "site_123")).toThrow(ConfigError);
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
