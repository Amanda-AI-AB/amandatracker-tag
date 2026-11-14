import { afterEach, describe, expect, it, vi } from "vitest";
import { boot } from "../src/core/boot";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import { HANDOFF_ATTRIBUTE, handedOff, shouldHandOff } from "../src/core/canary";
import { REFERRER_POLICY } from "../src/core/endpoint";
import type { PageviewInput } from "../src/core/pageview";
import { defaultTarget, tagErrorSink } from "../src/core/telemetry";
import { fakeWindow, jsonResponse, PAGE, scriptTag, type FakeWindow } from "./fake-window";
import { validator } from "./wire-validator";

const RUNNING = "0.2.0";
const PINNED = "0.3.0-canary.1";
const CONFIG = { schema_version: 1, site: "site_123", config_version: 7 };
const PINNED_CONFIG = { ...CONFIG, bundle_version: PINNED };
const SNIPPET = { src: "https://eu.serversider.com/a.js", "data-site": "site_123" };

/** A <script> element the tag creates: its attributes, and what the tag sets on it. */
interface FakeScript {
  readonly attributes: Record<string, string>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  async?: boolean;
  referrerPolicy?: string;
  src?: string;
  crossOrigin?: string;
  integrity?: string;
  onload?: () => void;
  onerror?: () => void;
}

/** Gives win's document createElement and a head, and returns the scripts appended to it. */
function withHead(win: FakeWindow): FakeScript[] {
  const appended: FakeScript[] = [];
  const createElement = vi.fn((tagName: string): FakeScript => {
    expect(tagName).toBe("script");
    const attributes: Record<string, string> = {};
    return {
      attributes,
      setAttribute: (name, value) => {
        attributes[name] = value;
      },
      getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name]! : null),
    };
  });
  Object.assign(win.document, { createElement, head: { appendChild: (s: FakeScript) => appended.push(s) } });
  return appended;
}

function setup(win: FakeWindow, tagVersion = RUNNING) {
  const reports: ErrorReport[] = [];
  const pageviews: PageviewInput[] = [];
  const boundary = new ErrorBoundary((report) => reports.push(report), 1);
  const booted = boot(win, { tagVersion, boundary, onPageview: (p) => pageviews.push(p) });
  return { reports, pageviews, booted };
}

/** Lets the boot's config fetch and its checks settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shouldHandOff", () => {
  const plain = scriptTag(SNIPPET);
  const marked = scriptTag({ ...SNIPPET, [HANDOFF_ATTRIBUTE]: RUNNING });

  it("hands off only when the pin names another build", () => {
    expect(shouldHandOff(PINNED, RUNNING, plain)).toBe(true);
    expect(shouldHandOff(undefined, RUNNING, plain)).toBe(false);
    expect(shouldHandOff(RUNNING, RUNNING, plain)).toBe(false);
  });

  it("never hands off again from a build that a handoff loaded", () => {
    expect(handedOff(marked)).toBe(true);
    expect(handedOff(plain)).toBe(false);
    expect(shouldHandOff("0.4.0", PINNED, marked)).toBe(false);
  });
});

describe("the canary pin", () => {
  it("loads the pinned versioned build exactly once, in place of the running one", async () => {
    const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(PINNED_CONFIG));
    const appended = withHead(win);
    const { reports, pageviews, booted } = setup(win);
    await settle();

    expect(appended).toHaveLength(1);
    const pinned = appended[0]!;
    expect(pinned.src).toBe(`https://eu.serversider.com/a.${PINNED}.js`);
    expect(pinned.async).toBe(true);
    expect(pinned.referrerPolicy).toBe(REFERRER_POLICY);
    expect(pinned.attributes).toEqual({ "data-site": "site_123", [HANDOFF_ATTRIBUTE]: RUNNING });

    pinned.onload!();
    expect(await booted).toBeUndefined();
    // The running build sent nothing, and left the snippet's stub for the pinned one.
    expect(pageviews).toEqual([]);
    expect(reports).toEqual([]);
    expect(win.amanda!.loaded).toBeUndefined();
    expect(win.fetchMock).toHaveBeenCalledTimes(1);
    expect(appended).toHaveLength(1);
  });

  it("hands data-endpoint on, and loads the pinned build through the proxy", async () => {
    const win = fakeWindow(scriptTag({ ...SNIPPET, "data-endpoint": "/amnda" }), jsonResponse(PINNED_CONFIG));
    const appended = withHead(win);
    setup(win);
    await settle();

    expect(appended).toHaveLength(1);
    expect(appended[0]!.src).toBe(`${PAGE}/amnda/a.${PINNED}.js`);
    expect(appended[0]!.attributes["data-endpoint"]).toBe("/amnda");
  });

  it("never makes the extra request for an unpinned config", async () => {
    const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(CONFIG));
    const appended = withHead(win);
    const { reports, pageviews, booted } = setup(win);

    expect(await booted).toMatchObject({ site: "site_123" });
    expect(appended).toEqual([]);
    expect(win.document.createElement).not.toHaveBeenCalled();
    expect(pageviews).toHaveLength(1);
    expect(reports).toEqual([]);
    expect(win.amanda!.loaded).toBe(true);
  });

  it("runs a build the config pins it to itself, without a request", async () => {
    const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(PINNED_CONFIG));
    const appended = withHead(win);
    const { pageviews, booted } = setup(win, PINNED);

    expect(await booted).toMatchObject({ site: "site_123" });
    expect(appended).toEqual([]);
    expect(pageviews.map((p) => p.tag_version)).toEqual([PINNED]);
  });

  it("runs a build that a handoff loaded, whatever build the config pins", async () => {
    const script = scriptTag({ ...SNIPPET, [HANDOFF_ATTRIBUTE]: RUNNING });
    const win = fakeWindow(script, jsonResponse({ ...CONFIG, bundle_version: "0.4.0" }));
    const appended = withHead(win);
    const { pageviews, booted } = setup(win, PINNED);

    expect(await booted).toMatchObject({ site: "site_123" });
    expect(appended).toEqual([]);
    expect(pageviews.map((p) => p.tag_version)).toEqual([PINNED]);
  });

  it("reports a pinned build that fails to load, and runs the running build instead", async () => {
    const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(PINNED_CONFIG));
    const appended = withHead(win);
    const { reports, pageviews, booted } = setup(win);
    await settle();

    appended[0]!.onerror!();
    expect(await booted).toMatchObject({ site: "site_123" });
    expect(reports).toEqual([
      {
        stage: "boot",
        name: "Error",
        message: `failed to load the pinned build ${PINNED} from https://eu.serversider.com/a.${PINNED}.js`,
      },
    ]);
    expect(pageviews.map((p) => p.tag_version)).toEqual([RUNNING]);
    expect(win.amanda!.loaded).toBe(true);
    expect(appended).toHaveLength(1);
  });

  it("refuses to load a pinned build from a third-party data-endpoint, and runs the running build", async () => {
    const win = fakeWindow(scriptTag({ ...SNIPPET, "data-endpoint": "https://t.example.com" }), jsonResponse(PINNED_CONFIG));
    const appended = withHead(win);
    const { reports, pageviews, booted } = setup(win);

    expect(await booted).toMatchObject({ site: "site_123" });
    expect(appended).toEqual([]);
    expect(reports).toEqual([expect.objectContaining({ stage: "boot", name: "EndpointError" })]);
    expect(pageviews).toHaveLength(1);
  });

  it("reports a pin that isn't a tag version as a config error, and loads nothing", async () => {
    const win = fakeWindow(scriptTag(SNIPPET), jsonResponse({ ...CONFIG, bundle_version: "latest" }));
    const appended = withHead(win);
    const { reports, pageviews, booted } = setup(win);

    expect(await booted).toBeUndefined();
    expect(appended).toEqual([]);
    expect(reports).toEqual([expect.objectContaining({ stage: "config", name: "ConfigError" })]);
    expect(pageviews).toEqual([]);
  });

  it("reports the handoff's failure as a tag error under the running build's tag_version", async () => {
    const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(PINNED_CONFIG));
    const appended = withHead(win);
    const posted: string[] = [];
    const sinkFetch = (async (_url: string, init: RequestInit) => {
      posted.push(init.body as string);
      return { ok: true, status: 204 };
    }) as unknown as typeof fetch;
    const target = defaultTarget();
    const boundary = new ErrorBoundary(tagErrorSink(sinkFetch, RUNNING, target), 1);
    const booted = boot(win, { tagVersion: RUNNING, boundary, target, onPageview: () => undefined });
    await settle();

    appended[0]!.onerror!();
    await booted;
    expect(posted).toHaveLength(1);
    const error = JSON.parse(posted[0]!);
    expect(error).toMatchObject({ tag_version: RUNNING, site_id: "site_123", stage: "boot", name: "Error" });
    expect(error.message).toMatch(new RegExp(`^failed to load the pinned build ${PINNED.replace(/\./g, "\\.")} from `));
    expect(validator("tag-error.json")(error)).toBe(true);
  });
});
