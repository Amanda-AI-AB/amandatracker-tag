import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { build } from "../scripts/build.mjs";
import {
  BUILDER_ID,
  BUILD_TYPE,
  headCommit,
  PREDICATE_TYPE,
  ProvenanceError,
  releaseArtifacts,
  releaseRef,
  releaseStatement,
  REPOSITORY,
  serialize,
  sha256,
  STATEMENT_TYPE,
  toolchain,
} from "../scripts/provenance.mjs";
import { parseStatement, reproduce, ReproducibilityError } from "../scripts/reproduce.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe("provenance", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tag-provenance-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A build's outdir as the release publishes from it: the core and two adapters. */
  function outdir(): string {
    const out = join(dir, "dist");
    mkdirSync(join(out, "adapters"), { recursive: true });
    writeFileSync(join(out, "a.js"), "core\n");
    writeFileSync(join(out, "adapters", "other-cmp.js"), "other\n");
    writeFileSync(join(out, "adapters", "example-cmp.js"), "example\n");
    writeFileSync(join(out, "provenance.json"), "{}\n");
    return out;
  }

  it("names each published file by its object name and SHA-256, and nothing else in dist/", () => {
    expect(releaseArtifacts(outdir(), "0.3.0").map(({ name, sha256: digest }) => ({ name, digest }))).toEqual([
      { name: "a.0.3.0.js", digest: sha256("core\n") },
      { name: "adapters/0.3.0/example-cmp.js", digest: sha256("example\n") },
      { name: "adapters/0.3.0/other-cmp.js", digest: sha256("other\n") },
    ]);
  });

  it("refuses an outdir without a core", () => {
    expect(() => releaseArtifacts(dir, "0.3.0")).toThrow(ProvenanceError);
  });

  it("is an in-toto statement of what was built, from which commit, lockfile and toolchain", () => {
    const provenance = releaseStatement({ env: "prod", tagName: "v0.3.0", dir: root, outdir: outdir(), version: "0.3.0", commit: COMMIT });
    const tools = toolchain(root);

    expect(provenance).toEqual({
      _type: STATEMENT_TYPE,
      subject: [
        { name: "a.0.3.0.js", digest: { sha256: sha256("core\n") } },
        { name: "adapters/0.3.0/example-cmp.js", digest: { sha256: sha256("example\n") } },
        { name: "adapters/0.3.0/other-cmp.js", digest: { sha256: sha256("other\n") } },
      ],
      predicateType: PREDICATE_TYPE,
      predicate: {
        buildDefinition: {
          buildType: BUILD_TYPE,
          externalParameters: { repository: REPOSITORY, ref: "refs/tags/v0.3.0", version: "0.3.0", environment: "prod" },
          resolvedDependencies: [
            { name: "source", uri: `git+${REPOSITORY}@refs/tags/v0.3.0`, digest: { gitCommit: COMMIT } },
            { name: "pnpm-lock.yaml", digest: { sha256: sha256(readFileSync(join(root, "pnpm-lock.yaml"))) } },
            { name: "esbuild", uri: `pkg:npm/esbuild@${tools.esbuild}` },
            { name: "pnpm", uri: `pkg:npm/pnpm@${tools.pnpm.version}`, digest: { sha512: tools.pnpm.sha512 } },
            { name: "node", uri: `pkg:generic/node@${process.version}` },
          ],
        },
        runDetails: { builder: { id: BUILDER_ID } },
      },
    });
  });

  it("is the same bytes each time for the same build, so a retried release finds its own object", () => {
    const out = outdir();
    const make = () =>
      serialize(releaseStatement({ env: "dev", dir: root, outdir: out, version: "0.3.1-dev.20261113185300.gabc1234", commit: COMMIT }));
    expect(make()).toBe(make());
    expect(make().endsWith("}\n")).toBe(true);
  });

  it("refuses a commit that isn't a full sha", () => {
    expect(() => releaseStatement({ env: "dev", dir: root, outdir: outdir(), version: "0.3.0", commit: "abc1234" })).toThrow(
      ProvenanceError,
    );
  });

  it("takes the ref from the release tag, or main for a dev build", () => {
    expect(releaseRef({ env: "prod", tagName: "v0.3.0" })).toBe("refs/tags/v0.3.0");
    expect(releaseRef({ env: "dev" })).toBe("refs/heads/main");
    expect(() => releaseRef({ env: "prod" })).toThrow(ProvenanceError);
    expect(() => releaseRef({ env: "staging" })).toThrow(ProvenanceError);
  });

  it("reads pnpm's version and hash from packageManager", () => {
    const { pnpm } = toolchain(root);
    const { packageManager } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { packageManager: string };
    expect(packageManager).toBe(`pnpm@${pnpm.version}+sha512.${pnpm.sha512}`);
  });
});

describe("reproduce", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tag-reproduce-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The provenance of a real build of this checkout's tag, as the release writes it. */
  async function released(): Promise<ReturnType<typeof releaseStatement>> {
    const outdir = join(dir, "dist");
    await build({ outdir, version: "0.3.0" });
    return parseStatement(
      JSON.parse(serialize(releaseStatement({ env: "prod", tagName: "v0.3.0", dir: root, outdir, version: "0.3.0" }))),
    );
  }

  it("rebuilds the release from its provenance, byte for byte", async () => {
    const provenance = await released();

    // the core and each of the repo's adapters
    expect(provenance.subject.map((s) => s.name)).toContain("adapters/0.3.0/cookiebot.js");
    expect(provenance.subject.map((s) => s.name)).toContain("adapters/0.3.0/onetrust.js");
    await expect(reproduce(provenance)).resolves.toEqual({ version: "0.3.0", subjects: provenance.subject.length });
  });

  it("names each file that came out differently", async () => {
    const provenance = await released();
    provenance.subject[0]!.digest.sha256 = "0".repeat(64);
    provenance.subject.push({ name: "adapters/0.3.0/gone.js", digest: { sha256: "1".repeat(64) } });

    const error = await reproduce(provenance).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReproducibilityError);
    expect((error as Error).message).toContain(`a.0.3.0.js: built `);
    expect((error as Error).message).toContain(`, published ${"0".repeat(64)}`);
    expect((error as Error).message).toContain("adapters/0.3.0/gone.js: not built");
  });

  it("names a file it built that the release doesn't have", async () => {
    const provenance = await released();
    provenance.subject = [];

    await expect(reproduce(provenance)).rejects.toThrow("a.0.3.0.js: built, but not in the release");
  });

  it("refuses a checkout of another commit before building", async () => {
    const provenance = await released();

    await expect(reproduce(provenance, { commit: COMMIT })).rejects.toThrow(
      `the checkout is at ${COMMIT}, and the release was built from ${headCommit()}`,
    );
  });

  it("refuses another lockfile before building", async () => {
    const provenance = await released();
    provenance.predicate.buildDefinition.resolvedDependencies[1]!.digest = { sha256: "2".repeat(64) };

    await expect(reproduce(provenance)).rejects.toThrow("pnpm-lock.yaml differs");
  });

  it("refuses what isn't a SLSA provenance statement", () => {
    expect(() => parseStatement({ _type: STATEMENT_TYPE, subject: [] })).toThrow(ProvenanceError);
    expect(() => parseStatement(null)).toThrow(ProvenanceError);
  });
});
