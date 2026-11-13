import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { build } from "../scripts/build.mjs";
import { SizeBudgetError } from "../scripts/size-gate.mjs";

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
    expect(coreGzipBytes).toBeLessThanOrEqual(15 * 1024);
  });

  it("lowers syntax to ES2018", async () => {
    const coreEntry = join(dir, "modern.ts");
    writeFileSync(coreEntry, "const o: { a?: { b: number } } = {}; console.log(o?.a?.b ?? 1);\n");
    const { coreFile } = await build({ coreEntry, adaptersDir: join(dir, "none"), outdir: join(dir, "dist") });

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
      build({ coreEntry, adaptersDir: join(dir, "none"), outdir: join(dir, "dist") }),
    ).rejects.toThrow(SizeBudgetError);
  });
});
