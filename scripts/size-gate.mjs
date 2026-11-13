// The core-bundle size gate: a.js must stay within 15 KB gzipped (spec 09 §2.6).
// `pnpm build` runs it after every build, so any CI that builds fails on an oversized bundle.
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { runMain } from "./cli.mjs";

/** 15 KB, counted in KiB: 15 × 1024 bytes after gzip at level 9. */
export const CORE_BUDGET_BYTES = 15 * 1024;

export class SizeBudgetError extends Error {
  /**
   * @param {string} file
   * @param {number} gzipBytes
   * @param {number} budgetBytes
   */
  constructor(file, gzipBytes, budgetBytes) {
    super(`${file} is ${gzipBytes} bytes gzipped, over its budget of ${budgetBytes} bytes`);
    this.name = "SizeBudgetError";
    this.file = file;
    this.gzipBytes = gzipBytes;
    this.budgetBytes = budgetBytes;
  }
}

/**
 * @param {Uint8Array | string} contents
 * @returns {number}
 */
export function gzipSize(contents) {
  return gzipSync(contents, { level: 9 }).length;
}

/**
 * Throws SizeBudgetError when the file's gzipped size exceeds the budget.
 * @param {string} file
 * @param {number} [budgetBytes]
 * @returns {number} the gzipped size in bytes
 */
export function checkBudget(file, budgetBytes = CORE_BUDGET_BYTES) {
  const size = gzipSize(readFileSync(file));
  if (size > budgetBytes) {
    throw new SizeBudgetError(file, size, budgetBytes);
  }
  return size;
}

await runMain(
  import.meta.url,
  () => {
    const file = process.argv[2];
    if (!file) {
      console.error("usage: node scripts/size-gate.mjs <file>");
      process.exit(2);
    }
    const size = checkBudget(file);
    console.log(`${file}: ${size} / ${CORE_BUDGET_BYTES} bytes gzipped`);
  },
  [[SizeBudgetError, "size gate failed"]],
);
