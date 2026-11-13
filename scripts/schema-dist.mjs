// Lays out the wire JSON Schema for a release: the newest version N and the one before it, N-1,
// under dist/schema/v<N>/, with a SHA256SUMS file. The release does not publish dist/schema/:
// consumers (the monorepo's shared/wire) pin a release tag, take schema/v<N>/ from it, and check
// their vendored copy against hashes they record themselves.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, runMain } from "./cli.mjs";
import { SCHEMA_ROOT, schemaFiles, schemaVersions } from "./schema-files.mjs";

/**
 * @param {{ schemaRoot?: string, outdir?: string }} [options]
 * @returns {{ versions: number[], files: string[] }} the versions published and their files,
 *   relative to outdir
 */
export function distSchema({ schemaRoot = SCHEMA_ROOT, outdir = join(ROOT, "dist/schema") } = {}) {
  const all = schemaVersions(schemaRoot);
  if (all.length === 0) throw new Error(`no schema/v<N> directory in ${schemaRoot}`);
  const versions = all.slice(-2);

  rmSync(outdir, { recursive: true, force: true });
  /** @type {string[]} */
  const files = [];
  for (const version of versions) {
    const dir = `v${version}`;
    mkdirSync(join(outdir, dir), { recursive: true });
    for (const name of schemaFiles(join(schemaRoot, dir))) {
      copyFileSync(join(schemaRoot, dir, name), join(outdir, dir, name));
      files.push(`${dir}/${name}`);
    }
  }
  const sums = files.map((file) => {
    const digest = createHash("sha256").update(readFileSync(join(outdir, file))).digest("hex");
    return `${digest}  ${file}\n`;
  });
  writeFileSync(join(outdir, "SHA256SUMS"), sums.join(""));
  return { versions, files };
}

await runMain(import.meta.url, () => {
  const { versions, files } = distSchema();
  console.log(`dist/schema: v${versions.join(", v")} (${files.length} files)`);
});
