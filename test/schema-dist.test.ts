import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { distSchema } from "../scripts/schema-dist.mjs";

describe("schema dist", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "schema-dist-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("publishes versions N and N-1 with their SHA-256 sums", () => {
    const schemaRoot = join(dir, "schema");
    for (const version of [1, 2, 3]) {
      mkdirSync(join(schemaRoot, `v${version}`), { recursive: true });
      writeFileSync(join(schemaRoot, `v${version}`, "event.json"), `{"v":${version}}`);
    }
    const outdir = join(dir, "dist");

    const { versions, files } = distSchema({ schemaRoot, outdir });

    expect(versions).toEqual([2, 3]);
    expect(files).toEqual(["v2/event.json", "v3/event.json"]);
    expect(existsSync(join(outdir, "v1"))).toBe(false);
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    expect(readFileSync(join(outdir, "SHA256SUMS"), "utf8")).toBe(
      `${sha('{"v":2}')}  v2/event.json\n${sha('{"v":3}')}  v3/event.json\n`,
    );
  });

  it("publishes the repo's schema: v1 alone while there is no v2", () => {
    const outdir = join(dir, "dist");
    const { versions, files } = distSchema({ outdir });
    expect(versions).toEqual([1]);
    expect(files).toEqual(["v1/event.json", "v1/ping.json", "v1/pubsub-message.json"]);
  });

  it("fails when there is no schema", () => {
    mkdirSync(join(dir, "schema"));
    expect(() => distSchema({ schemaRoot: join(dir, "schema"), outdir: join(dir, "dist") })).toThrow("no schema");
  });
});
