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

/**
 * A global scope with the browser APIs the tag uses at load time, and nothing of Node's: a page
 * installed by a.js's snippet for site_123, whose fetch answers with fetchFn (by default never).
 * Add to it what new top-level code needs, never a Node global.
 */
function browserContext(fetchFn: (url: string) => Promise<unknown> = () => new Promise(() => undefined)): Record<string, unknown> {
  const script = {
    tagName: "SCRIPT",
    getAttribute: (name: string) => ({ "data-site": "site_123" })[name] ?? null,
  };
  class Document {
    get currentScript(): unknown {
      return script;
    }
    readonly title = "Products";
    readonly referrer = "";
  }
  const context: Record<string, unknown> = {
    URL,
    TextEncoder,
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

  it("boots the built core: it fetches the site's config and installs window.amanda", async () => {
    const { coreFile } = await build({ outdir: join(dir, "dist") });
    const fetched: string[] = [];
    const context = browserContext(async (url) => {
      fetched.push(url);
      return { ok: true, status: 200, json: async () => ({ schema_version: 1, site: "site_123", config_version: 1 }) };
    });

    runInContext(readFileSync(coreFile, "utf8"), context, { filename: coreFile });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetched).toEqual(["https://eu.serversider.com/cfg/site_123.json"]);
    expect((context.amanda as { loaded?: boolean }).loaded).toBe(true);
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
