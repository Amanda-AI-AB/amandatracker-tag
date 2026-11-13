// Builds the tag: the core to one IIFE (dist/a.js), and each consent-manager adapter in
// src/adapters/ to its own IIFE (dist/adapters/<name>.js), which the core loads only when a
// site's config names it. ES2018, minified, no runtime dependencies. Then the size gate, and the
// wire JSON Schema's release layout in dist/schema/.
//
// The adapters build first: the core is built with its version and each adapter's SRI hash baked in
// (src/core/build-info.ts), and asks for adapters/<version>/<name>.js, where cloudbuild/release.yaml
// uploads them.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { ADAPTER_NAME } from "../src/core/adapter-name.mjs";
import { isSemver } from "./release-version.mjs";
import { distSchema } from "./schema-dist.mjs";
import { checkBudget, CORE_BUDGET_BYTES, SizeBudgetError } from "./size-gate.mjs";

const root = resolve(fileURLToPath(import.meta.url), "../..");

export class BuildError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "BuildError";
  }
}

/**
 * The version the core is built as: the release's, which cloudbuild/release.yaml's version step
 * writes to .release-version before it builds, or package.json's for a build outside a release (a
 * pull request's check, a local build).
 * @param {string} [dir] the repo root
 * @returns {string}
 */
export function buildVersion(dir = root) {
  const releaseFile = join(dir, ".release-version");
  const version = existsSync(releaseFile)
    ? readFileSync(releaseFile, "utf8").trim()
    : JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
  if (typeof version !== "string" || !isSemver(version)) {
    throw new BuildError(`the build version ${JSON.stringify(version)} is not semver`);
  }
  return version;
}

/**
 * @param {string} file
 * @returns {string} the file's SRI integrity metadata
 */
export function sriHash(file) {
  return `sha384-${createHash("sha384").update(readFileSync(file)).digest("base64")}`;
}

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
 * The adapters' entry files, by name. A missing directory is an error, never "no adapters", so that
 * moving it can't ship a build without them; so is a file whose name the core could never request.
 * @param {string} adaptersDir
 * @returns {{ name: string, entry: string }[]}
 */
export function adapterEntries(adaptersDir) {
  if (!existsSync(adaptersDir)) {
    throw new BuildError(`no adapters directory at ${adaptersDir}`);
  }
  return readdirSync(adaptersDir)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.endsWith(".d.ts"))
    .sort()
    .map((file) => {
      const name = file.slice(0, -".ts".length);
      if (!ADAPTER_NAME.test(name)) {
        throw new BuildError(`adapter file ${file}: the name must match ${ADAPTER_NAME}, which the core loads by`);
      }
      return { name, entry: join(adaptersDir, file) };
    });
}

/**
 * @param {{ coreEntry?: string, adaptersDir?: string, outdir?: string, budgetBytes?: number, version?: string }} [options]
 * @returns {Promise<{ coreFile: string, coreGzipBytes: number, adapterFiles: string[], version: string, adapterIntegrity: Record<string, string> }>}
 */
export async function build({
  coreEntry = join(root, "src/core/index.ts"),
  adaptersDir = join(root, "src/adapters"),
  outdir = join(root, "dist"),
  budgetBytes = CORE_BUDGET_BYTES,
  version = buildVersion(),
} = {}) {
  if (!isSemver(version)) throw new BuildError(`the build version ${JSON.stringify(version)} is not semver`);
  const adapters = adapterEntries(adaptersDir);
  // Start from an empty outdir, so that an adapter removed or renamed in src/adapters/ doesn't
  // leave its old dist/adapters/<name>.js behind to be published.
  rmSync(outdir, { recursive: true, force: true });
  const define = { __TAG_VERSION__: JSON.stringify(version) };

  const adapterOutdir = join(outdir, "adapters");
  if (adapters.length > 0) {
    await esbuild.build({ ...common, define, entryPoints: adapters.map((a) => a.entry), outdir: adapterOutdir });
  }
  const adapterFiles = [];
  /** @type {Record<string, string>} */
  const adapterIntegrity = {};
  for (const { name } of adapters) {
    const file = join(adapterOutdir, `${name}.js`);
    adapterFiles.push(file);
    adapterIntegrity[name] = sriHash(file);
  }

  const coreFile = join(outdir, "a.js");
  await esbuild.build({
    ...common,
    define: { ...define, __ADAPTER_INTEGRITY__: JSON.stringify(adapterIntegrity) },
    entryPoints: [coreEntry],
    outfile: coreFile,
  });

  const coreGzipBytes = checkBudget(coreFile, budgetBytes);
  return { coreFile, coreGzipBytes, adapterFiles, version, adapterIntegrity };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { coreFile, coreGzipBytes, adapterFiles, version } = await build();
    console.log(`${coreFile} (${version}): ${coreGzipBytes} / ${CORE_BUDGET_BYTES} bytes gzipped`);
    for (const file of adapterFiles) console.log(file);
    const { versions } = distSchema();
    console.log(`dist/schema: v${versions.join(", v")}`);
  } catch (error) {
    if (error instanceof BuildError) {
      console.error(`build failed: ${error.message}`);
      process.exit(1);
    }
    if (!(error instanceof SizeBudgetError)) throw error;
    console.error(`size gate failed: ${error.message}`);
    process.exit(1);
  }
}
