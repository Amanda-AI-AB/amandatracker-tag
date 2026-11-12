import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { build } from "../scripts/build.mjs";
import { SizeBudgetError } from "../scripts/size-gate.mjs";

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
    expect(code.trimStart().startsWith("(()=>{")).toBe(true);
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
    expect(adapter.trimStart().startsWith("(()=>{")).toBe(true);
    expect(readFileSync(coreFile, "utf8")).not.toContain("example-cmp adapter");
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
