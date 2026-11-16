// Builds the npm package (AAI-222) to dist/npm/: the tag for a site that bundles its front end,
// from src/npm/index.ts, the same source as a.js (both start the tag with src/core/tag.ts). It is one
// ES module, ES2018, with no dependencies and the version and adapter hashes of the a.js it is
// released with baked in, as a.js has them, so that it loads that release's adapters; its type
// declarations, index.d.ts; its package.json; and the LICENSE. Unminified: the site's bundler
// minifies it with the rest of the site's code. pnpm build builds it after the core.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as esbuild from "esbuild";
import ts from "typescript";
import { ROOT } from "./cli.mjs";

export const NPM_PACKAGE_NAME = "amandatracker-tag";

export class NpmBuildError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "NpmBuildError";
  }
}

/**
 * The type declarations of `entry`, under tsconfig.src.json's options. The entry's exported
 * signatures use only its own types, so that its index.d.ts imports nothing the package doesn't have.
 * @param {string} entry
 * @returns {string}
 */
export function declarations(entry) {
  const configFile = join(ROOT, "tsconfig.src.json");
  const { config, error } = ts.readConfigFile(configFile, ts.sys.readFile);
  if (error) throw new NpmBuildError(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
  const { options } = ts.parseJsonConfigFileContent(config, ts.sys, ROOT, undefined, configFile);
  const program = ts.createProgram([entry], {
    ...options,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
  });
  const entryFile = entry.replace(/\\/g, "/");
  /** @type {string | undefined} */
  let text;
  const result = program.emit(undefined, (_fileName, data, _bom, _onError, sourceFiles) => {
    if (sourceFiles?.some((f) => f.fileName === entryFile)) text = data;
  });
  const problems = [...ts.getPreEmitDiagnostics(program), ...result.diagnostics];
  if (problems.length > 0) {
    throw new NpmBuildError(problems.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"));
  }
  if (text === undefined) throw new NpmBuildError(`no declarations were emitted for ${entry}`);
  if (/^\s*import\b/m.test(text)) {
    throw new NpmBuildError(`${entry}'s declarations import other modules, which the package doesn't have:\n${text}`);
  }
  return text;
}

/**
 * The package's package.json.
 * @param {string} version
 */
export function npmManifest(version) {
  return {
    name: NPM_PACKAGE_NAME,
    version,
    description: "The Amanda Tracker website tag for bundled front ends: first-party cookies only, consent-native.",
    license: "Apache-2.0",
    repository: { type: "git", url: "git+https://github.com/Amanda-AI-AB/amandatracker-tag.git" },
    type: "module",
    main: "./index.js",
    module: "./index.js",
    types: "./index.d.ts",
    exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
    // Importing it starts nothing: the tag starts at init.
    sideEffects: false,
    files: ["index.js", "index.d.ts", "LICENSE"],
  };
}

/**
 * @param {{ version: string, adapterIntegrity: Record<string, string>, entry?: string, outdir?: string }} options
 *   `version` and `adapterIntegrity` are those of the core build it is released with (build.mjs).
 * @returns {Promise<{ dir: string, moduleFile: string }>}
 */
export async function buildNpm({ version, adapterIntegrity, entry = join(ROOT, "src/npm/index.ts"), outdir = join(ROOT, "dist/npm") }) {
  mkdirSync(outdir, { recursive: true });
  const moduleFile = join(outdir, "index.js");
  await esbuild.build({
    bundle: true,
    format: "esm",
    target: "es2018",
    platform: "browser",
    minify: false,
    legalComments: "none",
    logLevel: "warning",
    banner: { js: `/*! ${NPM_PACKAGE_NAME} ${version} */` },
    define: { __TAG_VERSION__: JSON.stringify(version), __ADAPTER_INTEGRITY__: JSON.stringify(adapterIntegrity) },
    entryPoints: [entry],
    outfile: moduleFile,
  });
  writeFileSync(join(outdir, "index.d.ts"), declarations(entry));
  writeFileSync(join(outdir, "package.json"), `${JSON.stringify(npmManifest(version), null, 2)}\n`);
  copyFileSync(join(ROOT, "LICENSE"), join(outdir, "LICENSE"));
  return { dir: outdir, moduleFile };
}
