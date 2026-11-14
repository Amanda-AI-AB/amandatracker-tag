// The release's provenance (AAI-148): an in-toto Statement with a SLSA v1 provenance predicate that
// names each file the release publishes, by its object name and SHA-256, and what it was built from:
// the repository, the ref and commit, the lockfile, and the toolchain. cloudbuild/release.yaml runs
// it after the build, writes dist/provenance.json, and publishes it as a.<version>.provenance.json
// beside the core. scripts/reproduce.mjs rebuilds from a statement and compares, so anyone can check
// that a published a.<version>.js is exactly what the tagged source builds to.
//
// The statement is deterministic: no build id and no timestamp, so a retried build of the same commit
// writes the same bytes, and the immutable upload finds its own object. It is not signed.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import * as esbuild from "esbuild";
import { buildVersion } from "./build.mjs";
import { ROOT, runMain } from "./cli.mjs";
import { RELEASE_ENVS } from "./release-version.mjs";

export const REPOSITORY = "https://github.com/Amanda-AI-AB/amandatracker-tag";
export const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const PREDICATE_TYPE = "https://slsa.dev/provenance/v1";
// How a release is built, and how to rebuild one: the guide that reproduce.mjs follows.
export const BUILD_TYPE = `${REPOSITORY}/blob/main/docs/verifying-a-release.md`;
export const BUILDER_ID = `${REPOSITORY}/blob/main/cloudbuild/release.yaml`;

export class ProvenanceError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ProvenanceError";
  }
}

/**
 * @param {string | Buffer} contents
 * @returns {string} its SHA-256, hex
 */
export function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

/**
 * The files a release publishes from a build's outdir, by the object name each is published under,
 * as cloudbuild/release.yaml's upload step names them: the core as a.<version>.js, and each adapter
 * as adapters/<version>/<name>.js. Sorted by name.
 * @param {string} outdir
 * @param {string} version
 * @returns {{ name: string, file: string, sha256: string }[]}
 */
export function releaseArtifacts(outdir, version) {
  const core = join(outdir, "a.js");
  if (!existsSync(core)) throw new ProvenanceError(`no core at ${core}: build first`);
  const artifacts = [{ name: `a.${version}.js`, file: core }];
  const adapterDir = join(outdir, "adapters");
  if (existsSync(adapterDir)) {
    for (const file of readdirSync(adapterDir).filter((f) => f.endsWith(".js"))) {
      artifacts.push({ name: `adapters/${version}/${file}`, file: join(adapterDir, file) });
    }
  }
  return artifacts
    .map((a) => ({ ...a, sha256: sha256(readFileSync(a.file)) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The toolchain a build ran with: Node's version, pnpm's from package.json's packageManager (with its
 * hash), and esbuild's, which alone shapes the output.
 * @param {string} [dir] the repo root
 * @returns {{ node: string, pnpm: { version: string, sha512: string }, esbuild: string }}
 */
export function toolchain(dir = ROOT) {
  const { packageManager } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const match = /^pnpm@(\d+\.\d+\.\d+)\+sha512\.([0-9a-f]{128})$/.exec(packageManager ?? "");
  const [, version, sha512] = match ?? [];
  if (version === undefined || sha512 === undefined) {
    throw new ProvenanceError(`package.json's packageManager ${JSON.stringify(packageManager)} is not pnpm@<version>+sha512.<hash>`);
  }
  return { node: process.version, pnpm: { version, sha512 }, esbuild: esbuild.version };
}

/**
 * The commit checked out in `dir`.
 * @param {string} [dir]
 * @returns {string}
 */
export function headCommit(dir = ROOT) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

/**
 * The ref a release builds from: its tag `v<semver>`, or main for a dev build, which runs on each
 * push to main.
 * @param {{ env: string, tagName?: string }} release
 * @returns {string}
 */
export function releaseRef({ env, tagName = "" }) {
  if (!RELEASE_ENVS.includes(env)) {
    throw new ProvenanceError(`unknown release environment ${JSON.stringify(env)}: expected dev or prod`);
  }
  if (tagName !== "") return `refs/tags/${tagName}`;
  if (env === "prod") throw new ProvenanceError("a prod release builds only from a release tag");
  return "refs/heads/main";
}

/**
 * @typedef {{ name: string, digest: { sha256: string } }} Subject
 * @typedef {{
 *   _type: string,
 *   subject: Subject[],
 *   predicateType: string,
 *   predicate: {
 *     buildDefinition: {
 *       buildType: string,
 *       externalParameters: { repository: string, ref: string, version: string, environment: string },
 *       resolvedDependencies: { name: string, uri?: string, digest?: Record<string, string> }[],
 *     },
 *     runDetails: { builder: { id: string } },
 *   },
 * }} Statement
 */

/**
 * @param {{
 *   artifacts: { name: string, sha256: string }[],
 *   version: string,
 *   env: string,
 *   ref: string,
 *   commit: string,
 *   lockfileSha256: string,
 *   tools: ReturnType<typeof toolchain>,
 * }} build
 * @returns {Statement}
 */
export function statement({ artifacts, version, env, ref, commit, lockfileSha256, tools }) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new ProvenanceError(`${JSON.stringify(commit)} is not a full commit sha`);
  return {
    _type: STATEMENT_TYPE,
    subject: artifacts.map(({ name, sha256: digest }) => ({ name, digest: { sha256: digest } })),
    predicateType: PREDICATE_TYPE,
    predicate: {
      buildDefinition: {
        buildType: BUILD_TYPE,
        externalParameters: { repository: REPOSITORY, ref, version, environment: env },
        resolvedDependencies: [
          { name: "source", uri: `git+${REPOSITORY}@${ref}`, digest: { gitCommit: commit } },
          { name: "pnpm-lock.yaml", digest: { sha256: lockfileSha256 } },
          { name: "esbuild", uri: `pkg:npm/esbuild@${tools.esbuild}` },
          { name: "pnpm", uri: `pkg:npm/pnpm@${tools.pnpm.version}`, digest: { sha512: tools.pnpm.sha512 } },
          { name: "node", uri: `pkg:generic/node@${tools.node}` },
        ],
      },
      runDetails: { builder: { id: BUILDER_ID } },
    },
  };
}

/**
 * The statement for the build in `outdir` of the checkout in `dir`.
 * @param {{ env: string, tagName?: string, dir?: string, outdir?: string, version?: string, commit?: string }} release
 * @returns {Statement}
 */
export function releaseStatement({
  env,
  tagName = "",
  dir = ROOT,
  outdir = join(dir, "dist"),
  version = buildVersion(dir),
  commit = headCommit(dir),
}) {
  return statement({
    artifacts: releaseArtifacts(outdir, version),
    version,
    env,
    ref: releaseRef({ env, tagName }),
    commit,
    lockfileSha256: sha256(readFileSync(join(dir, "pnpm-lock.yaml"))),
    tools: toolchain(dir),
  });
}

/**
 * @param {Statement} provenance
 * @returns {string} the statement as published: two-space JSON and a final newline
 */
export function serialize(provenance) {
  return `${JSON.stringify(provenance, null, 2)}\n`;
}

await runMain(
  import.meta.url,
  () => {
    const provenance = releaseStatement({ env: process.env.RELEASE_ENV ?? "", tagName: process.env.TAG_NAME ?? "" });
    const file = join(ROOT, "dist/provenance.json");
    writeFileSync(file, serialize(provenance));
    console.log(`${relative(ROOT, file)}: ${provenance.subject.map((s) => `${s.name} ${s.digest.sha256}`).join(", ")}`);
  },
  [[ProvenanceError, "provenance"]],
);
