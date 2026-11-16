import { describe, expect, it } from "vitest";
import { boot } from "../src/core/boot";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import { ConfigError, identifyEnabled, parseConfig } from "../src/core/config";
import { checkUserRef, identifyCommand, USER_REF_MAX_LENGTH, type IdentifyInput } from "../src/core/identify";
import { CommandError, type AmandaFunction } from "../src/core/queue";
import { buildEvent, WirePayloadError } from "../src/wire/payload";
import { fakeWindow, jsonResponse, PAGE, scriptTag } from "./fake-window";
import { EVENT, PAGE_EXIT, PING, PURCHASE, validator } from "./wire-validator";

const SNIPPET = { src: "https://eu.serversider.com/a.js", "data-site": "site_123" };
const START = 1_731_400_000_000;
const BASE = { schema_version: 1, site: "site_123", config_version: 7 };
const ENABLED = { ...BASE, features: { identify_enabled: true } };
const REF = "c0ffee4b1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e";

/** The ref shapes of raw email addresses a tenant might pass, each of which must never leave the browser. */
const EMAILS = [
  "anna.svensson@example.se",
  "ANNA@EXAMPLE.SE",
  " anna@example.se ",
  "mailto:anna@example.se",
  "customer:anna+shop@example.co.uk",
  "anna@localhost",
];

function identifyPage(config: object, withSink = true, queued: unknown[][] = []) {
  const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(config));
  if (queued.length > 0) {
    const stub: AmandaFunction = function (...args: unknown[]) {
      (stub.q = stub.q || []).push(args);
    };
    stub.q = queued;
    win.amanda = stub;
  }
  const reports: ErrorReport[] = [];
  const identified: IdentifyInput[] = [];
  const boundary = new ErrorBoundary((report) => reports.push(report), 1);
  const booted = boot(win, {
    tagVersion: "0.2.0",
    boundary,
    onPageview: () => undefined,
    ...(withSink ? { onIdentify: (input: IdentifyInput) => identified.push(input) } : {}),
    now: () => START,
  });
  return { win, booted, reports, identified };
}

describe("amanda('identify') (AAI-786)", () => {
  it("sends user_ref on an identify event when the site's config turns identify on", async () => {
    const { win, booted, reports, identified } = identifyPage(ENABLED);
    await booted;

    win.amanda!("identify", REF);

    expect(reports).toEqual([]);
    expect(identified).toEqual([
      {
        type: "identify",
        site_id: "site_123",
        tag_version: "0.2.0",
        client_ts: START,
        url: `${PAGE}/products?id=1`,
        page_title: "Products",
        language: "sv-SE",
        user_ref: REF,
      },
    ]);
  });

  it("sends an identify event the wire schema accepts once the ids and consent are added", async () => {
    const { win, booted, identified } = identifyPage(ENABLED);
    await booted;
    win.amanda!("identify", REF);

    const event = buildEvent({
      ...identified[0]!,
      visitor_id: "01934f6c-8d2a-7b3c-8d4e-5f6a7b8c9d01",
      session_id: "01934f6c-8d2a-7b3c-ad4e-5f6a7b8c9d02",
      consent: { analytics: "granted", ads: "granted" },
    });
    const validate = validator("event.json");
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
    expect(event).toMatchObject({ type: "identify", user_ref: REF });
  });

  it("runs an identify call the snippet queued before the tag loaded", async () => {
    const { booted, identified } = identifyPage(ENABLED, true, [["identify", REF]]);
    await booted;

    expect(identified.map((input) => input.user_ref)).toEqual([REF]);
  });

  it.each([
    ["no features section", BASE],
    ["no identify_enabled", { ...BASE, features: {} }],
    ["identify_enabled false", { ...BASE, features: { identify_enabled: false } }],
  ])("is off by default: refuses and reports with %s, sending nothing", async (_, config) => {
    const { win, booted, reports, identified } = identifyPage(config);
    await booted;

    win.amanda!("identify", REF);

    expect(identified).toEqual([]);
    expect(reports).toEqual([
      { stage: "command", name: "CommandError", message: "amanda('identify') is off for this site: its config doesn't turn identify on" },
    ]);
  });

  it.each(EMAILS)("refuses the email-shaped ref %j, sends nothing and never quotes it", async (email) => {
    const { win, booted, reports, identified } = identifyPage(ENABLED);
    await booted;

    win.amanda!("identify", email);

    expect(identified).toEqual([]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ stage: "command", name: "CommandError" });
    expect(reports[0]!.message).toContain("email address");
    expect(JSON.stringify(reports)).not.toContain("example");
  });

  it("has no identify command without a sink", async () => {
    const { win, booted, reports } = identifyPage(ENABLED, false);
    await booted;

    win.amanda!("identify", REF);

    expect(reports).toEqual([{ stage: "command", name: "CommandError", message: "unknown command: identify" }]);
  });
});

describe("checkUserRef", () => {
  it("takes a pseudonymous ref verbatim, up to the cap", () => {
    expect(checkUserRef(REF)).toBe(REF);
    expect(checkUserRef("cust_4711")).toBe("cust_4711");
    expect(checkUserRef("x".repeat(USER_REF_MAX_LENGTH))).toBe("x".repeat(USER_REF_MAX_LENGTH));
    // Counted as the schema counts, by code point.
    expect(checkUserRef("😀".repeat(USER_REF_MAX_LENGTH))).toBe("😀".repeat(USER_REF_MAX_LENGTH));
  });

  it.each([
    ["an email address", "anna@example.se"],
    ["a lone @", "@"],
    ["an empty string", ""],
    ["a number", 4711],
    ["null", null],
    ["undefined", undefined],
    ["an object", { id: "x" }],
    ["a ref over the cap", "x".repeat(USER_REF_MAX_LENGTH + 1)],
  ])("refuses %s", (_, ref) => {
    expect(() => checkUserRef(ref)).toThrow(CommandError);
  });
});

describe("identifyCommand", () => {
  it("takes exactly one argument", () => {
    const sent: string[] = [];
    const command = identifyCommand(true, (ref) => sent.push(ref));

    expect(() => command()).toThrow(CommandError);
    expect(() => command(REF, { extra: true })).toThrow(CommandError);
    command(REF);
    expect(sent).toEqual([REF]);
  });

  it("refuses before it looks at the ref when it is off", () => {
    const command = identifyCommand(false, () => undefined);

    expect(() => command("anna@example.se")).toThrow("is off for this site");
  });
});

describe("config: features.identify_enabled", () => {
  it("is on only when the config sets it true", () => {
    expect(identifyEnabled(parseConfig(ENABLED, "site_123"))).toBe(true);
    expect(identifyEnabled(parseConfig(BASE, "site_123"))).toBe(false);
    expect(identifyEnabled(parseConfig({ ...BASE, features: { identify_enabled: false } }, "site_123"))).toBe(false);
    // Another ticket's toggle in the section leaves identify off.
    expect(identifyEnabled(parseConfig({ ...BASE, features: { scroll_enabled: true } }, "site_123"))).toBe(false);
  });

  it.each([
    ["a features section that isn't an object", { ...BASE, features: ["identify"] }],
    ["a null features section", { ...BASE, features: null }],
    ["an identify_enabled that isn't a boolean", { ...BASE, features: { identify_enabled: "true" } }],
  ])("refuses %s", (_, config) => {
    expect(() => parseConfig(config, "site_123")).toThrow(ConfigError);
  });
});

describe("wire schema v1: user_ref (AAI-786)", () => {
  const validate = validator("event.json");

  it("rides on any event", () => {
    for (const event of [EVENT, PURCHASE, PAGE_EXIT]) {
      expect(validate({ ...event, user_ref: REF }), JSON.stringify(validate.errors)).toBe(true);
    }
    expect(validate({ ...EVENT, type: "identify", user_ref: REF }), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each<[string, unknown]>([
    ...EMAILS.map((email): [string, unknown] => [`the email address ${JSON.stringify(email)}`, email]),
    ["an empty ref", ""],
    ["a ref over 128 characters", "x".repeat(129)],
    ["a number", 4711],
  ])("refuses %s", (_, ref) => {
    expect(validate({ ...EVENT, type: "identify", user_ref: ref })).toBe(false);
  });

  it("is never in a ping", () => {
    expect(validator("ping.json")({ ...PING, user_ref: REF })).toBe(false);
  });

  it("is refused, never cut, by the payload builder when over the cap or email-shaped", () => {
    const { schema_version, event_id, ...rest } = { ...EVENT, type: "identify" };
    expect(() => buildEvent({ ...rest, user_ref: "x".repeat(129) })).toThrow(
      new WirePayloadError("event.user_ref", "is over its cap of 128 characters"),
    );
    expect(() => buildEvent({ ...rest, user_ref: "anna@example.se" })).toThrow(WirePayloadError);
  });
});
