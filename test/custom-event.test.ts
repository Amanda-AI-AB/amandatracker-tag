// amanda('event', name, props) (AAI-979): the command that hands over the site's own custom event,
// its name as the event's type and its props held to the wire schema's Props. Refused names and
// props are reported through the boundary, and nothing is handed over.
import { afterEach, describe, expect, it, vi } from "vitest";
import { boot } from "../src/core/boot";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import { checkEventName, checkProps, eventCommand, TAG_EVENT_TYPES, type CustomEvent, type CustomEventInput } from "../src/core/custom-event";
import { CommandError, type AmandaFunction } from "../src/core/queue";
import { buildEvent } from "../src/wire/payload";
import { fakeWindow, jsonResponse, PAGE, scriptTag } from "./fake-window";
import { validator } from "./wire-validator";

const SNIPPET = { src: "https://eu.serversider.com/a.js", "data-site": "site_123" };
const START = 1_731_400_000_000;
const CONFIG = { schema_version: 1, site: "site_123", config_version: 7 };
const IDS = { visitor_id: "01934f6c-8d2a-7b3c-8d4e-5f6a7b8c9d01", session_id: "01934f6c-8d2a-7b3c-ad4e-5f6a7b8c9d02" };
const CONSENT = { analytics: "granted", ads: "granted" } as const;

const validateEvent = validator("event.json");

afterEach(() => {
  vi.restoreAllMocks();
});

function stub(queued: unknown[][]): AmandaFunction {
  const amanda: AmandaFunction = function (...args: unknown[]) {
    (amanda.q = amanda.q || []).push(args);
  };
  amanda.q = queued;
  return amanda;
}

/** A booted page whose custom events go to `events`. */
function eventPage(options: { withSink?: boolean; queued?: unknown[][] } = {}) {
  const { withSink = true, queued = [] } = options;
  const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(CONFIG));
  if (queued.length > 0) win.amanda = stub(queued);
  const reports: ErrorReport[] = [];
  const events: CustomEventInput[] = [];
  const boundary = new ErrorBoundary((report) => reports.push(report), 1);
  const booted = boot(win, {
    tagVersion: "0.2.0",
    boundary,
    onPageview: () => undefined,
    ...(withSink ? { onEvent: (input: CustomEventInput) => events.push(input) } : {}),
    now: () => START,
  });
  return { win, booted, reports, events };
}

describe("amanda('event') (AAI-979)", () => {
  it("hands over an event with the name as its type and the props", async () => {
    const { win, booted, reports, events } = eventPage();
    await booted;

    win.amanda!("event", "signup", { plan: "pro", seats: 3, trial: true });

    expect(reports).toEqual([]);
    expect(events).toEqual([
      {
        type: "signup",
        site_id: "site_123",
        tag_version: "0.2.0",
        client_ts: START,
        url: `${PAGE}/products?id=1`,
        page_title: "Products",
        language: "sv-SE",
        props: { plan: "pro", seats: 3, trial: true },
      },
    ]);
  });

  it("makes an event the schema accepts, a TrackedEvent with its props", async () => {
    const { win, booted, events } = eventPage();
    await booted;

    win.amanda!("event", "signup", { plan: "pro" });

    const event = buildEvent({ ...events[0]!, ...IDS, consent: CONSENT });
    expect(validateEvent(event), JSON.stringify(validateEvent.errors)).toBe(true);
    expect(event).toMatchObject({ type: "signup", props: { plan: "pro" } });
  });

  it("takes a call without props, and sends no props", async () => {
    const { win, booted, reports, events } = eventPage();
    await booted;

    win.amanda!("event", "newsletter_open");
    win.amanda!("event", "newsletter_open", undefined);
    win.amanda!("event", "newsletter_open", {});

    expect(reports).toEqual([]);
    expect(events).toHaveLength(3);
    for (const input of events) {
      expect(input).not.toHaveProperty("props");
      expect(validateEvent(buildEvent({ ...input, ...IDS, consent: CONSENT }))).toBe(true);
    }
  });

  it("runs an event call the snippet queued before the tag loaded", async () => {
    const { booted, events } = eventPage({ queued: [["event", "signup", { plan: "pro" }]] });
    await booted;

    expect(events.map((input) => input.type)).toEqual(["signup"]);
  });

  it("refuses a bad name or bad props, reports it, and sends nothing", async () => {
    const { win, booted, reports, events } = eventPage();
    await booted;

    win.amanda!("event", "pageview");
    win.amanda!("event", "signup", { am_source: "x" });

    expect(events).toEqual([]);
    expect(reports).toEqual([
      { stage: "command", name: "CommandError", message: "amanda('event', name, props) refuses the name pageview: the tag sends that event itself" },
      {
        stage: "command",
        name: "CommandError",
        message: `amanda('event', name, props) refuses the props key "am_source": keys are not empty and never start with am_`,
      },
    ]);
  });

  it("has no event command without a sink", async () => {
    const { win, booted, reports } = eventPage({ withSink: false });
    await booted;

    win.amanda!("event", "signup");

    expect(reports).toEqual([{ stage: "command", name: "CommandError", message: "unknown command: event" }]);
  });
});

describe("checkEventName", () => {
  it("takes a name of up to 64 characters, counted by code point", () => {
    expect(checkEventName("signup")).toBe("signup");
    expect(checkEventName("x".repeat(64))).toBe("x".repeat(64));
    expect(checkEventName("😀".repeat(64))).toBe("😀".repeat(64));
  });

  it.each([
    ["no name", undefined],
    ["null", null],
    ["a number", 42],
    ["an empty name", ""],
    ["a name over 64 characters", "x".repeat(65)],
    ...TAG_EVENT_TYPES.map((type) => [`the tag's own ${type}`, type] as [string, unknown]),
  ])("refuses %s with a CommandError", (_, name) => {
    expect(() => checkEventName(name)).toThrow(CommandError);
  });

  it("never quotes a name over its cap", () => {
    expect(() => checkEventName("anna@example.se".repeat(10))).toThrow(/^(?!.*anna).*over 64 characters/);
  });
});

describe("checkProps", () => {
  it("takes strings, finite numbers and booleans, and leaves undefined values out", () => {
    expect(checkProps({ plan: "pro", seats: 3, price: 9.5, trial: false, coupon: undefined })).toEqual({
      plan: "pro",
      seats: 3,
      price: 9.5,
      trial: false,
    });
  });

  it("takes 25 keys and strings of 200 characters, counted by code point", () => {
    const props = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, "😀".repeat(200)]));
    expect(checkProps(props)).toEqual(props);
  });

  it("counts only the keys it keeps against the cap", () => {
    const props: Record<string, unknown> = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, i]));
    props.unset = undefined;
    expect(Object.keys(checkProps(props))).toHaveLength(25);
  });

  it("returns a copy: changing the props afterwards changes nothing", () => {
    const props = { plan: "pro" };
    const kept = checkProps(props);
    props.plan = "free";
    expect(kept).toEqual({ plan: "pro" });
  });

  it.each([
    ["null", null],
    ["an array", [["plan", "pro"]]],
    ["a string", "plan=pro"],
    ["more than 25 keys", Object.fromEntries(Array.from({ length: 26 }, (_, i) => [`k${i}`, i]))],
    ["an am_ key", { am_source: "x" }],
    ["the key am_", { am_: "x" }],
    ["an empty key", { "": "x" }],
    ["a string over 200 characters", { note: "x".repeat(201) }],
    ["a nested object", { user: { plan: "pro" } }],
    ["an array value", { tags: ["a"] }],
    ["null", { plan: null }],
    ["NaN", { seats: NaN }],
    ["Infinity", { seats: Infinity }],
    ["a function", { cb: () => undefined }],
  ])("refuses %s with a CommandError", (_, props) => {
    expect(() => checkProps(props)).toThrow(CommandError);
  });

  it("never quotes a value in its refusal", () => {
    expect(() => checkProps({ email: "anna@example.se".repeat(20) })).toThrow(/^(?!.*anna).*props\.email/);
  });
});

describe("eventCommand", () => {
  it("takes a name and, optionally, props, and no more", () => {
    const sent: CustomEvent[] = [];
    const command = eventCommand((event) => sent.push(event));

    expect(() => command()).toThrow(CommandError);
    expect(() => command("signup", {}, { extra: true })).toThrow(CommandError);
    command("signup");
    command("signup", { plan: "pro" });
    command("signup", { coupon: undefined });
    expect(sent).toEqual([{ name: "signup" }, { name: "signup", props: { plan: "pro" } }, { name: "signup" }]);
  });
});
