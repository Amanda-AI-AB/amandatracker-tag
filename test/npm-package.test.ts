// The npm package end to end (AAI-222): built as pnpm build builds it (scripts/build-npm.mjs),
// installed in a site's node_modules, bundled into the site's own code by esbuild as a bundled SPA's
// build would, and run in a vm context that holds browser globals alone. Its init boots the same tag
// as a.js, from the site and endpoint it is given, and its pageview reaches /v1/e as a.js's does.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import * as esbuild from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildNpm, NPM_PACKAGE_NAME } from "../scripts/build-npm.mjs";
import { VISITOR_COOKIE } from "../src/core/identity";
import { CookieJar } from "./cookie-jar";
import { validator } from "./wire-validator";

const PAGE = "https://shop.example.com";
const CONFIG = { schema_version: 1, site: "site_123", config_version: 7, consent: { declined_mode: "off" } };
const validateBatch = validator("batch.json");

let dir: string;
let packageDir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tag-npm-"));
  packageDir = join(dir, "site", "node_modules", NPM_PACKAGE_NAME);
  await buildNpm({ version: "1.2.3", adapterIntegrity: {}, outdir: packageDir });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Bundles `source`, the site's own code, as its build would: importing the package from node_modules. */
async function bundleSite(source: string): Promise<string> {
  const siteDir = join(dir, "site");
  mkdirSync(join(siteDir, "src"), { recursive: true });
  writeFileSync(join(siteDir, "src", "app.js"), source);
  const result = await esbuild.build({
    absWorkingDir: siteDir,
    entryPoints: ["src/app.js"],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2018",
    minify: true,
    write: false,
    logLevel: "silent",
  });
  return result.outputFiles[0]!.text;
}

interface Request {
  readonly url: string;
  readonly body?: string;
}

/**
 * A page on PAGE/products whose fetch answers the config with CONFIG and anything else with 204,
 * with the browser globals the tag uses and nothing of Node's.
 */
function browserPage(window: Record<string, unknown> = {}) {
  const requests: Request[] = [];
  const jar = new CookieJar("shop.example.com");
  class Document {
    get currentScript(): unknown {
      // A bundled site's code runs from the site's own script, which names no site.
      return null;
    }
    readonly title = "Products";
    readonly referrer = "";
    readonly visibilityState = "visible";
    get cookie(): string {
      return jar.cookie;
    }
    set cookie(value: string) {
      jar.cookie = value;
    }
    addEventListener(): void {}
  }
  const context: Record<string, unknown> = {
    URL,
    TextEncoder,
    crypto: globalThis.crypto,
    setTimeout,
    clearTimeout,
    Document,
    document: new Document(),
    location: { href: `${PAGE}/products`, origin: PAGE },
    navigator: { language: "sv-SE", sendBeacon: () => true },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
    fetch: async (url: string, init?: { body?: string }) => {
      requests.push({ url, ...(init?.body === undefined ? {} : { body: init.body }) });
      const config = url.endsWith("/cfg/site_123.json");
      return { ok: true, status: config ? 200 : 204, json: async () => CONFIG };
    },
    ...window,
  };
  context.window = context;
  context.self = context;
  return { context: createContext(context), requests, jar };
}

/** Lets the boot's fetches and the transport's flush settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("the npm package", () => {
  it("is an ES module package with types, its version, and no dependencies", () => {
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    expect(manifest).toMatchObject({
      name: NPM_PACKAGE_NAME,
      version: "1.2.3",
      license: "Apache-2.0",
      type: "module",
      sideEffects: false,
      exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
    });
    expect(manifest.dependencies).toBeUndefined();
    expect(readFileSync(join(packageDir, "LICENSE"), "utf8")).toContain("Apache License");
    const module = readFileSync(join(packageDir, "index.js"), "utf8");
    expect(module.startsWith(`/*! ${NPM_PACKAGE_NAME} 1.2.3 */`)).toBe(true);
    expect(module).not.toMatch(/^\s*import\b/m);
  });

  it("declares init and amanda, importing nothing", () => {
    const types = readFileSync(join(packageDir, "index.d.ts"), "utf8");
    expect(types).toMatch(/export declare function init\(options: InitOptions\): Promise<boolean>;/);
    expect(types).toMatch(/export declare function amanda\(command: string, \.\.\.args: unknown\[\]\): void;/);
    expect(types).not.toMatch(/^\s*import\b/m);
  });

  it("tracks in a bundled SPA: init boots the tag, and the granted pageview reaches /v1/e as a.js's does", async () => {
    const page = browserPage();
    const app = await bundleSite(
      `import { amanda, init } from "${NPM_PACKAGE_NAME}";\n` +
        `amanda("consent", { analytics: "granted", ads: "granted" });\n` +
        `window.booted = init({ site: "site_123" });\n`,
    );

    runInContext(app, page.context);
    expect(await (page.context.booted as Promise<boolean>)).toBe(true);
    await settle();

    expect(page.requests.map((r) => r.url)).toEqual([
      "https://eu.serversider.com/cfg/site_123.json",
      "https://eu.serversider.com/v1/e",
    ]);
    const batch = JSON.parse(page.requests[1]!.body!);
    expect(validateBatch(batch), JSON.stringify(validateBatch.errors)).toBe(true);
    expect(batch.seq).toBe(1);
    expect(batch.e).toHaveLength(1);
    expect(batch.e[0]).toMatchObject({
      type: "pageview",
      site_id: "site_123",
      tag_version: "1.2.3",
      url: `${PAGE}/products`,
      consent: { analytics: "granted", ads: "granted", source: "manual" },
    });
    expect(page.jar.cookie).toContain(`${VISITOR_COOKIE}=v1.${batch.e[0].visitor_id}`);
    expect((page.context.amanda as { loaded?: boolean }).loaded).toBe(true);
  });

  it("sends through the endpoint init names, such as a first-party reverse proxy's path", async () => {
    const page = browserPage();
    const app = await bundleSite(
      `import { amanda, init } from "${NPM_PACKAGE_NAME}";\n` +
        `amanda("consent", { analytics: "granted", ads: "granted" });\n` +
        `window.booted = init({ site: "site_123", endpoint: "/amnda" });\n`,
    );

    runInContext(app, page.context);
    expect(await (page.context.booted as Promise<boolean>)).toBe(true);
    await settle();

    expect(page.requests.map((r) => r.url)).toEqual([`${PAGE}/amnda/cfg/site_123.json`, `${PAGE}/amnda/v1/e`]);
  });

  it("starts nothing on import: no request, and amanda's calls queue until init", async () => {
    const page = browserPage();
    const app = await bundleSite(
      `import { amanda } from "${NPM_PACKAGE_NAME}";\n` + `amanda("event", "signup", { plan: "pro" });\n`,
    );

    runInContext(app, page.context);
    await settle();

    expect(page.requests).toEqual([]);
    expect((page.context.amanda as { q?: unknown[][] }).q?.map((args) => Array.from(args as ArrayLike<unknown>))).toEqual([
      ["event", "signup", { plan: "pro" }],
    ]);
  });

  it("leaves a page alone where a.js already runs: init settles false and fetches nothing", async () => {
    const aJs = Object.assign(() => undefined, { loaded: true as const });
    const page = browserPage({ amanda: aJs });
    const app = await bundleSite(`import { init } from "${NPM_PACKAGE_NAME}";\nwindow.booted = init({ site: "site_123" });\n`);

    runInContext(app, page.context);

    expect(await (page.context.booted as Promise<boolean>)).toBe(false);
    expect(page.requests).toEqual([]);
    expect(page.context.amanda).toBe(aJs);
  });

  it("refuses init and amanda on a server, where there is no window", async () => {
    const { init, amanda } = await import(join(packageDir, "index.js"));

    expect(() => init({ site: "site_123" })).toThrow(/no window/);
    expect(() => amanda("event", "signup")).toThrow(/no window/);
  });
});
