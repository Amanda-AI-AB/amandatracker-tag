// Builds the tag: the core to one IIFE (dist/a.js), and each consent-manager adapter in
// src/adapters/ to its own IIFE (dist/adapters/<name>.js), which the core loads only when a
// site's config names it. ES2018, minified, no runtime dependencies. Then the size gate, and the
// wire JSON Schema's release layout in dist/schema/.
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { distSchema } from "./schema-dist.mjs";
import { checkBudget, CORE_BUDGET_BYTES, SizeBudgetError } from "./size-gate.mjs";

const root = resolve(fileURLToPath(import.meta.url), "../..");

/** @type {import("esbuild").BuildOptions} */
const common = {
  bundle: true,
  format: "iife",
  target: "es2018",
  platform: "browser",
  minify: true,
  legalComments: "none",
  logLevel: "warning",
};

/**
 * @param {string} adaptersDir
 * @returns {string[]} adapter entry files
 */
export function adapterEntries(adaptersDir) {
  if (!existsSync(adaptersDir)) return [];
  return readdirSync(adaptersDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts"))
    .sort()
    .map((name) => join(adaptersDir, name));
}

/**
 * @param {{ coreEntry?: string, adaptersDir?: string, outdir?: string, budgetBytes?: number }} [options]
 * @returns {Promise<{ coreFile: string, coreGzipBytes: number, adapterFiles: string[] }>}
 */
export async function build({
  coreEntry = join(root, "src/core/index.ts"),
  adaptersDir = join(root, "src/adapters"),
  outdir = join(root, "dist"),
  budgetBytes = CORE_BUDGET_BYTES,
} = {}) {
  const coreFile = join(outdir, "a.js");
  await esbuild.build({ ...common, entryPoints: [coreEntry], outfile: coreFile });

  const adapters = adapterEntries(adaptersDir);
  const adapterOutdir = join(outdir, "adapters");
  if (adapters.length > 0) {
    await esbuild.build({ ...common, entryPoints: adapters, outdir: adapterOutdir });
  }
  const adapterFiles = adapters.map((entry) =>
    join(adapterOutdir, entry.slice(adaptersDir.length + 1).replace(/\.ts$/, ".js")),
  );

  const coreGzipBytes = checkBudget(coreFile, budgetBytes);
  return { coreFile, coreGzipBytes, adapterFiles };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { coreFile, coreGzipBytes, adapterFiles } = await build();
    console.log(`${coreFile}: ${coreGzipBytes} / ${CORE_BUDGET_BYTES} bytes gzipped`);
    for (const file of adapterFiles) console.log(file);
    const { versions } = distSchema();
    console.log(`dist/schema: v${versions.join(", v")}`);
  } catch (error) {
    if (!(error instanceof SizeBudgetError)) throw error;
    console.error(`size gate failed: ${error.message}`);
    process.exit(1);
  }
}
