import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adapterEntries, build, BuildError, buildVersion, sriHash } from "../scripts/build.mjs";
import { CORE_BUDGET_BYTES, SizeBudgetError } from "../scripts/size-gate.mjs";

// esbuild keeps the "use strict" directive of strict TypeScript ahead of the IIFE.
const IIFE = /^("use strict";)?\(\(\)=>\{[\s\S]*\}\)\(\);\s*$/;

describe("build", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tag-build-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits the core as one IIFE within the budget", async () => {
    const outdir = join(dir, "dist");
    const { coreFile, coreGzipBytes } = await build({ outdir });

    const code = readFileSync(coreFile, "utf8");
    expect(coreFile).toBe(join(outdir, "a.js"));
    expect(code).toMatch(IIFE);
    expect(code).not.toMatch(/\bimport\s*[{(*"']|\bexport\s*[{*]|\brequire\(/);
    expect(coreGzipBytes).toBeLessThanOrEqual(CORE_BUDGET_BYTES);
  });

  function emptyAdaptersDir(): string {
    const adaptersDir = join(dir, "no-adapters");
    mkdirSync(adaptersDir);
    return adaptersDir;
  }

  it("lowers syntax to ES2018", async () => {
    const coreEntry = join(dir, "modern.ts");
    writeFileSync(coreEntry, "const o: { a?: { b: number } } = {}; console.log(o?.a?.b ?? 1);\n");
    const { coreFile } = await build({ coreEntry, adaptersDir: emptyAdaptersDir(), outdir: join(dir, "dist") });

    const code = readFileSync(coreFile, "utf8");
    expect(code).not.toContain("?.");
    expect(code).not.toContain("??");
  });

  it("builds each adapter as its own IIFE beside the core", async () => {
    const adaptersDir = join(dir, "adapters");
    mkdirSync(adaptersDir);
    writeFileSync(join(adaptersDir, "example-cmp.ts"), "console.log('example-cmp adapter');\n");
    writeFileSync(join(adaptersDir, "example-cmp.test.ts"), "throw new Error('not an entry');\n");
    const outdir = join(dir, "dist");

    const { coreFile, adapterFiles } = await build({ adaptersDir, outdir });

    expect(adapterFiles).toEqual([join(outdir, "adapters", "example-cmp.js")]);
    const adapter = readFileSync(adapterFiles[0]!, "utf8");
    expect(adapter).toMatch(IIFE);
    expect(readFileSync(coreFile, "utf8")).not.toContain("example-cmp adapter");
  });

  it("removes what an earlier build left in the outdir", async () => {
    const adaptersDir = join(dir, "adapters");
    mkdirSync(adaptersDir);
    writeFileSync(join(adaptersDir, "bar.ts"), "console.log('bar adapter');\n");
    const outdir = join(dir, "dist");
    mkdirSync(join(outdir, "adapters"), { recursive: true });
    writeFileSync(join(outdir, "adapters", "foo.js"), "console.log('stale foo adapter');\n");
    writeFileSync(join(outdir, "stale.txt"), "stale\n");

    await build({ adaptersDir, outdir });

    expect(existsSync(join(outdir, "adapters", "foo.js"))).toBe(false);
    expect(existsSync(join(outdir, "stale.txt"))).toBe(false);
    expect(readdirSync(join(outdir, "adapters"))).toEqual(["bar.js"]);
  });

  it("fails on a deliberately oversized core bundle", async () => {
    const coreEntry = join(dir, "oversized.ts");
    // An incompressible string literal of 24 KB: well over 15 KB even after gzip.
    const payload = randomBytes(18 * 1024).toString("base64");
    writeFileSync(coreEntry, `console.log(${JSON.stringify(payload)});\n`);

    await expect(
      build({ coreEntry, adaptersDir: emptyAdaptersDir(), outdir: join(dir, "dist") }),
    ).rejects.toThrow(SizeBudgetError);
  });

  it("bakes the version and each adapter's SRI hash into the core", async () => {
    const adaptersDir = join(dir, "adapters");
    mkdirSync(adaptersDir);
    writeFileSync(join(adaptersDir, "example-cmp.ts"), "console.log('example-cmp adapter');\n");
    const coreEntry = join(dir, "core.ts");
    writeFileSync(
      coreEntry,
      "declare const __TAG_VERSION__: string; declare const __ADAPTER_INTEGRITY__: object;\n" +
        "console.log(__TAG_VERSION__, JSON.stringify(__ADAPTER_INTEGRITY__));\n",
    );
    const outdir = join(dir, "dist");

    const { coreFile, adapterFiles, version, adapterIntegrity } = await build({
      coreEntry,
      adaptersDir,
      outdir,
      version: "1.2.3-dev.gabc1234",
    });

    const digest = createHash("sha384").update(readFileSync(adapterFiles[0]!)).digest("base64");
    expect(version).toBe("1.2.3-dev.gabc1234");
    expect(adapterIntegrity).toEqual({ "example-cmp": `sha384-${digest}` });
    expect(sriHash(adapterFiles[0]!)).toBe(`sha384-${digest}`);
    const code = readFileSync(coreFile, "utf8");
    expect(code).toContain('"1.2.3-dev.gabc1234"');
    expect(code).toContain(`sha384-${digest}`);
  });

  it("refuses a version that isn't semver", async () => {
    await expect(build({ adaptersDir: emptyAdaptersDir(), outdir: join(dir, "dist"), version: "1.2" })).rejects.toThrow(
      BuildError,
    );
  });

  it("fails when the adapters directory is missing, rather than ship none", async () => {
    await expect(build({ adaptersDir: join(dir, "moved"), outdir: join(dir, "dist") })).rejects.toThrow(
      "no adapters directory",
    );
  });

  it("refuses an adapter file whose name the core could never request", () => {
    const adaptersDir = join(dir, "adapters");
    mkdirSync(adaptersDir);
    writeFileSync(join(adaptersDir, "OneTrust.ts"), "console.log('unreachable');\n");
    expect(() => adapterEntries(adaptersDir)).toThrow(BuildError);
  });

  it("ships the repo's adapters directory", () => {
    expect(() => adapterEntries(fileURLToPath(new URL("../src/adapters", import.meta.url)))).not.toThrow();
  });
});

describe("buildVersion", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tag-version-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.3.0" }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is package.json's version outside a release", () => {
    expect(buildVersion(dir)).toBe("0.3.0");
  });

  it("is the release's, from .release-version, when the release pipeline wrote one", () => {
    writeFileSync(join(dir, ".release-version"), "0.3.0-dev.gabc1234\n");
    expect(buildVersion(dir)).toBe("0.3.0-dev.gabc1234");
  });

  it("refuses a .release-version that isn't semver", () => {
    writeFileSync(join(dir, ".release-version"), "\n");
    expect(() => buildVersion(dir)).toThrow(BuildError);
  });
});
