// Rebuilds a release from its provenance (scripts/provenance.mjs) and checks that every file it
// names comes out byte for byte the same: `pnpm reproduce <a.<version>.provenance.json>`, in a
// checkout of the commit it names, after `pnpm install --frozen-lockfile`. The rebuild goes to a
// directory of its own, so dist/ is left as it is. cloudbuild/release.yaml runs it on every release
// before anything is uploaded, so that each published build is one a second build reproduced; and
// anyone can run it against a published statement (docs/verifying-a-release.md).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "./build.mjs";
import { ROOT, runMain } from "./cli.mjs";
import { headCommit, PREDICATE_TYPE, ProvenanceError, releaseArtifacts, sha256, STATEMENT_TYPE, toolchain } from "./provenance.mjs";

export class ReproducibilityError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ReproducibilityError";
  }
}

/**
 * @param {unknown} value
 * @returns {import("./provenance.mjs").Statement}
 */
export function parseStatement(value) {
  const s = /** @type {any} */ (value);
  if (s?._type !== STATEMENT_TYPE || s?.predicateType !== PREDICATE_TYPE || !Array.isArray(s?.subject)) {
    throw new ProvenanceError(`not an in-toto statement with a ${PREDICATE_TYPE} predicate`);
  }
  const deps = s.predicate?.buildDefinition?.resolvedDependencies;
  if (typeof s.predicate?.buildDefinition?.externalParameters?.version !== "string" || !Array.isArray(deps)) {
    throw new ProvenanceError("the statement has no version or no resolved dependencies");
  }
  return s;
}

/**
 * @param {import("./provenance.mjs").Statement} provenance
 * @param {string} name
 * @param {string} algorithm
 * @returns {string}
 */
function dependencyDigest(provenance, name, algorithm) {
  const dep = provenance.predicate.buildDefinition.resolvedDependencies.find((d) => d.name === name);
  const digest = dep?.digest?.[algorithm];
  if (typeof digest !== "string") throw new ProvenanceError(`the statement names no ${algorithm} for ${name}`);
  return digest;
}

/**
 * Rebuilds the release `provenance` describes from the checkout in `dir`, and compares.
 * @param {import("./provenance.mjs").Statement} provenance
 * @param {{ dir?: string, commit?: string, build?: typeof build }} [options] `commit` is the checkout's
 *   HEAD, read from git when not given; `build` is scripts/build.mjs's, with the defaults it has there.
 * @returns {Promise<{ version: string, subjects: number }>}
 */
export async function reproduce(provenance, { dir = ROOT, commit = headCommit(dir), build: run = build } = {}) {
  const { version } = provenance.predicate.buildDefinition.externalParameters;
  const wantCommit = dependencyDigest(provenance, "source", "gitCommit");
  if (commit !== wantCommit) {
    throw new ReproducibilityError(`the checkout is at ${commit}, and the release was built from ${wantCommit}: check that out first`);
  }
  const wantLock = dependencyDigest(provenance, "pnpm-lock.yaml", "sha256");
  if (sha256(readFileSync(join(dir, "pnpm-lock.yaml"))) !== wantLock) {
    throw new ReproducibilityError("pnpm-lock.yaml differs from the one the release was built with");
  }

  const outdir = mkdtempSync(join(tmpdir(), "tag-reproduce-"));
  try {
    await run({ coreEntry: join(dir, "src/core/index.ts"), adaptersDir: join(dir, "src/adapters"), outdir, version });
    const built = new Map(releaseArtifacts(outdir, version).map((a) => [a.name, a.sha256]));
    const want = new Map(provenance.subject.map((s) => [s.name, s.digest.sha256]));
    /** @type {string[]} */
    const problems = [];
    for (const [name, digest] of want) {
      const got = built.get(name);
      if (got === undefined) problems.push(`${name}: not built`);
      else if (got !== digest) problems.push(`${name}: built ${got}, published ${digest}`);
    }
    for (const name of built.keys()) {
      if (!want.has(name)) problems.push(`${name}: built, but not in the release`);
    }
    if (problems.length > 0) {
      const esbuildDep = provenance.predicate.buildDefinition.resolvedDependencies.find((d) => d.name === "esbuild");
      const ours = `pkg:npm/esbuild@${toolchain(dir).esbuild}`;
      const hint = esbuildDep?.uri === ours ? "" : `\n(the release used ${esbuildDep?.uri}, this build ${ours})`;
      throw new ReproducibilityError(`the rebuild differs from the release:\n  ${problems.join("\n  ")}${hint}`);
    }
    return { version, subjects: want.size };
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}

await runMain(
  import.meta.url,
  async () => {
    const path = process.argv[2];
    if (path === undefined) throw new ProvenanceError("usage: pnpm reproduce <a.<version>.provenance.json>");
    const { version, subjects } = await reproduce(parseStatement(JSON.parse(readFileSync(path, "utf8"))));
    console.log(`${version}: all ${subjects} published files reproduced byte for byte`);
  },
  [
    [ProvenanceError, "reproduce"],
    [ReproducibilityError, "reproduce"],
  ],
);
