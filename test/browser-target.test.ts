// The tag runs in browsers, while its tests run in Node, so two checks keep src/ to the browser's
// APIs (AAI-936): tsconfig.src.json type-checks src/ without Node's types and with the ES2018 lib,
// and the built a.js and adapters are evaluated here in a vm context that holds browser globals
// alone, without Buffer, process or require.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { build } from "../scripts/build.mjs";
import { validator } from "./wire-validator";

const root = fileURLToPath(new URL("..", import.meta.url));

/** tsc's errors for `file` under tsconfig.src.json's compiler options. */
function srcDiagnostics(file: string): string[] {
  const configFile = join(root, "tsconfig.src.json");
  const { config, error } = ts.readConfigFile(configFile, ts.sys.readFile);
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
  const { options, errors } = ts.parseJsonConfigFileContent(config, ts.sys, root, undefined, configFile);
  if (errors.length > 0) throw new Error(errors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, "\n")).join("\n"));
  const program = ts.createProgram([file], options);
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

/** A script element: its attributes, and what the tag sets on it. */
interface FakeScript {
  readonly tagName: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  src?: string;
  onload?: () => void;
}

function fakeScript(attributes: Record<string, string>, tagName = "SCRIPT"): FakeScript {
  return {
    tagName,
    getAttribute: (name) => attributes[name] ?? null,
    setAttribute: (name, value) => {
      attributes[name] = value;
    },
  };
}

/** The page's script elements: the one whose code runs now, and those the tag appended to its head. */
interface BrowserPage {
  current: FakeScript;
  readonly appended: FakeScript[];
}

/**
 * A global scope with the browser APIs the tag uses at load time, and nothing of Node's: a page
 * installed by a.js's snippet for site_123, whose fetch answers with fetchFn (by default never).
 * Add to it what new top-level code needs, never a Node global.
 */
function browserContext(
  fetchFn: (url: string, init?: unknown) => Promise<unknown> = () => new Promise(() => undefined),
  page: BrowserPage = { current: fakeScript({ "data-site": "site_123" }), appended: [] },
): Record<string, unknown> {
  class Document {
    get currentScript(): unknown {
      return page.current;
    }
    readonly title = "Products";
    readonly referrer = "";
    readonly visibilityState = "visible";
    readonly head = { appendChild: (script: FakeScript) => page.appended.push(script) };
    addEventListener(): void {}
    createElement(tagName: string): FakeScript {
      return fakeScript({}, tagName.toUpperCase());
    }
  }
  const context: Record<string, unknown> = {
    URL,
    TextEncoder,
    // Web Crypto, which browsers have: Node's globalThis.crypto is the same API
    crypto: globalThis.crypto,
    Document,
    document: new Document(),
    location: { href: "https://shop.example.com/products", origin: "https://shop.example.com" },
    navigator: { language: "sv-SE" },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
    fetch: fetchFn,
  };
  context.window = context;
  context.self = context;
  return createContext(context);
}

describe("browser target", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tag-browser-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("type-checks src/ with tsconfig.src.json in pnpm typecheck", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.scripts.typecheck).toContain("-p tsconfig.src.json");
  });

  it("refuses Node's globals and post-ES2018 built-ins in src/", () => {
    const probe = join(dir, "probe.ts");
    writeFileSync(
      probe,
      'export const a = [1, 2].at(-1);\nexport const b = Buffer.from("x");\nexport const c = process.env.X;\n',
    );
    const errors = srcDiagnostics(probe);
    expect(errors).toHaveLength(3);
    expect(errors.join("\n")).toMatch(/'at'/);
    expect(errors.join("\n")).toMatch(/'Buffer'/);
    expect(errors.join("\n")).toMatch(/'process'/);
  });

  it("accepts ES2018 and the DOM in src/", () => {
    const probe = join(dir, "probe.ts");
    writeFileSync(
      probe,
      "export const a = [1, 2].includes(2);\nexport const b = new TextEncoder().encode('x').length;\n" +
        "export const c = (d: Document) => d.createElement('script');\n",
    );
    expect(srcDiagnostics(probe)).toEqual([]);
  });

  it("evaluates the built core and adapters with browser globals alone", async () => {
    const { coreFile, adapterFiles } = await build({ outdir: join(dir, "dist") });
    for (const file of [coreFile, ...adapterFiles]) {
      expect(() => runInContext(readFileSync(file, "utf8"), browserContext(), { filename: file })).not.toThrow();
    }
  });

  it("runs the built Cookiebot adapter: it connects through amanda('adapter', ...) and signals Cookiebot's answer", async () => {
    const { adapterFiles } = await build({ outdir: join(dir, "dist") });
    const file = adapterFiles.find((f) => f.endsWith("cookiebot.js"))!;
    const context = browserContext();
    const calls: unknown[][] = [];
    context.amanda = (...args: unknown[]) => calls.push(args);
    context.Cookiebot = { hasResponse: true, consent: { necessary: true, preferences: false, statistics: true, marketing: false } };

    runInContext(readFileSync(file, "utf8"), context, { filename: file });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 2)).toEqual(["adapter", "cookiebot"]);
    const signals: unknown[] = [];
    (calls[0]![2] as (api: unknown) => void)({ signal: (s: unknown) => signals.push(s), guard: (fn: () => void) => fn() });
    expect(signals).toEqual([{ analytics: "granted", ads: "denied" }]);
  });

  it("runs the built OneTrust adapter: it connects, signals OneTrust's answer, and hooks OptanonWrapper", async () => {
    const { adapterFiles } = await build({ outdir: join(dir, "dist") });
    const file = adapterFiles.find((f) => f.endsWith("onetrust.js"))!;
    const context = browserContext();
    const calls: unknown[][] = [];
    context.amanda = (...args: unknown[]) => calls.push(args);
    context.OneTrust = { IsAlertBoxClosed: () => true };
    context.OnetrustActiveGroups = ",C0001,C0004,";

    runInContext(readFileSync(file, "utf8"), context, { filename: file });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 2)).toEqual(["adapter", "onetrust"]);
    const signals: unknown[] = [];
    (calls[0]![2] as (api: unknown) => void)({ signal: (s: unknown) => signals.push(s), guard: (fn: () => void) => fn() });
    context.OnetrustActiveGroups = ",C0001,C0002,";
    (context.OptanonWrapper as () => void)();
    expect(signals).toEqual([
      { analytics: "denied", ads: "granted" },
      { analytics: "granted", ads: "denied" },
    ]);
  });

  it("boots the built core: it fetches the site's config and installs window.amanda", async () => {
    const { coreFile } = await build({ outdir: join(dir, "dist") });
    const fetched: string[] = [];
    const page: BrowserPage = { current: fakeScript({ "data-site": "site_123" }), appended: [] };
    const context = browserContext(async (url) => {
      fetched.push(url);
      return { ok: true, status: 200, json: async () => ({ schema_version: 1, site: "site_123", config_version: 1 }) };
    }, page);

    runInContext(readFileSync(coreFile, "utf8"), context, { filename: coreFile });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetched).toEqual(["https://eu.serversider.com/cfg/site_123.json"]);
    expect((context.amanda as { loaded?: boolean }).loaded).toBe(true);
    // An unpinned config never loads another build.
    expect(page.appended).toEqual([]);
  });

  it("hands a pinned site off to the versioned build once, and that build reports under its own tag_version", async () => {
    const running = await build({ outdir: join(dir, "running"), version: "0.2.0" });
    const pinned = await build({ outdir: join(dir, "pinned"), version: "0.3.0-canary.1" });
    const config = { schema_version: 1, site: "site_123", config_version: 2, bundle_version: "0.3.0-canary.1" };
    const requests: { url: string; body: string | undefined }[] = [];
    const page: BrowserPage = { current: fakeScript({ "data-site": "site_123" }), appended: [] };
    const context = browserContext(async (url, init) => {
      requests.push({ url, body: (init as { body?: string } | undefined)?.body });
      return { ok: true, status: url.endsWith("/v1/t") ? 204 : 200, json: async () => config };
    }, page);
    // a sampled page, whose snippet queued a command no build has
    runInContext("Math.random = () => 0;", context);
    runInContext("window.amanda = function () { (amanda.q = amanda.q || []).push(arguments); }; amanda('no-such-command');", context);

    runInContext(readFileSync(running.coreFile, "utf8"), context, { filename: running.coreFile });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(page.appended).toHaveLength(1);
    const script = page.appended[0]!;
    expect(script.src).toBe("https://eu.serversider.com/a.0.3.0-canary.1.js");
    expect((context.amanda as { loaded?: boolean }).loaded).toBeUndefined();

    // The browser runs the pinned build from the script tag the running one appended.
    page.current = script;
    runInContext(readFileSync(pinned.coreFile, "utf8"), context, { filename: pinned.coreFile });
    script.onload!();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(page.appended).toHaveLength(1);
    expect((context.amanda as { loaded?: boolean }).loaded).toBe(true);
    expect(requests.map((r) => r.url)).toEqual([
      "https://eu.serversider.com/cfg/site_123.json",
      "https://eu.serversider.com/cfg/site_123.json",
      "https://eu.serversider.com/v1/t",
    ]);
    const report = JSON.parse(requests[2]!.body!);
    expect(report).toMatchObject({ tag_version: "0.3.0-canary.1", site_id: "site_123", stage: "command", name: "CommandError" });
    expect(validator("tag-error.json")(report)).toBe(true);
  });

  it("reports a failed boot of the built core to the collector as a tag error", async () => {
    const { coreFile } = await build({ outdir: join(dir, "dist") });
    const requests: { url: string; init?: { body?: string; credentials?: string } }[] = [];
    const context = browserContext(async (url, init) => {
      requests.push({ url, init: init as { body?: string; credentials?: string } });
      return { ok: url.endsWith("/v1/t"), status: url.endsWith("/v1/t") ? 204 : 404, json: async () => ({}) };
    });
    // a sampled page
    runInContext("Math.random = () => 0;", context);

    runInContext(readFileSync(coreFile, "utf8"), context, { filename: coreFile });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requests.map((r) => r.url)).toEqual([
      "https://eu.serversider.com/cfg/site_123.json",
      "https://eu.serversider.com/v1/t",
    ]);
    expect(requests[1]!.init!.credentials).toBe("omit");
    const report = JSON.parse(requests[1]!.init!.body!);
    expect(report).toMatchObject({ site_id: "site_123", stage: "config", name: "ConfigError", message: "GET https://eu.serversider.com HTTP 404" });
    expect(validator("tag-error.json")(report)).toBe(true);
  });

  it("fails a build that uses a Node global at load time", async () => {
    const adaptersDir = join(dir, "adapters");
    mkdirSync(adaptersDir);
    const coreEntry = join(dir, "node-core.ts");
    writeFileSync(coreEntry, 'declare const Buffer: { byteLength(s: string): number };\n(self as any).n = Buffer.byteLength("x");\n');
    const { coreFile } = await build({ coreEntry, adaptersDir, outdir: join(dir, "dist") });

    expect(() => runInContext(readFileSync(coreFile, "utf8"), browserContext())).toThrow(/Buffer is not defined/);
  });
});
