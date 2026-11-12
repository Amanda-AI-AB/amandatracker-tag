import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkBudget, CORE_BUDGET_BYTES, gzipSize, SizeBudgetError } from "../scripts/size-gate.mjs";

describe("size gate", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "size-gate-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("budgets 15 KB gzipped", () => {
    expect(CORE_BUDGET_BYTES).toBe(15 * 1024);
  });

  it("passes a file within the budget and returns its gzipped size", () => {
    const file = join(dir, "small.js");
    writeFileSync(file, "console.log(1);");
    expect(checkBudget(file)).toBe(gzipSize("console.log(1);"));
  });

  it("fails a file whose gzipped size exceeds the budget", () => {
    const file = join(dir, "big.js");
    // Random bytes don't compress, so 20 KB of them stays over 15 KB gzipped.
    writeFileSync(file, randomBytes(20 * 1024).toString("base64"));
    expect(() => checkBudget(file)).toThrow(SizeBudgetError);
  });

  it("counts the gzipped size, not the raw one", () => {
    const file = join(dir, "repetitive.js");
    writeFileSync(file, "a".repeat(100 * 1024));
    expect(checkBudget(file)).toBeLessThan(CORE_BUDGET_BYTES);
  });
});
