// The Cloud Build pipelines can't run here, so these tests check their shape, and run the release's
// shell steps the way Cloud Build would: substitutions applied, with a stand-in `gcloud` on PATH
// (test/fake-gcloud.sh) that records its arguments and keeps the buckets in a local directory instead
// of reaching Google Cloud.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = fileURLToPath(new URL("..", import.meta.url));

interface Step {
  id: string;
  name: string;
  entrypoint?: string;
  args?: string[];
  env?: string[];
}

interface BuildConfig {
  steps: Step[];
  substitutions?: Record<string, string>;
  timeout?: string;
  options?: { logging?: string; env?: string[] };
}

function load(file: string): BuildConfig {
  return parse(readFileSync(join(root, "cloudbuild", file), "utf8")) as BuildConfig;
}

// Cloud Build's own substitutions that these pipelines use; any other `$NAME` fails the build.
const BUILT_INS = ["TAG_NAME", "SHORT_SHA"];

/** Applies substitutions as Cloud Build does: `$$` is a literal `$`, and an unknown name is an error. */
function substitute(text: string, values: Record<string, string>): string {
  return text.replace(/\$\$|\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (match, braced?: string, bare?: string) => {
    if (match === "$$") return "$";
    const name = (braced ?? bare)!;
    const value = values[name];
    if (value === undefined) throw new Error(`${match} is not a substitution of this build`);
    return value;
  });
}

const CHECKS = [
  { id: "install", args: ["pnpm", "install", "--frozen-lockfile"] },
  { id: "typecheck", args: ["pnpm", "typecheck"] },
  { id: "test", args: ["pnpm", "test"] },
  { id: "build", args: ["pnpm", "build"] },
];

function checkSteps(config: BuildConfig): { id: string; args: string[] | undefined }[] {
  return config.steps
    .filter((step) => step.entrypoint === "corepack")
    .map((step) => ({ id: step.id, args: step.args }));
}

describe.each(["pr.yaml", "release.yaml"])("cloudbuild/%s", (file) => {
  it("logs to Cloud Logging only, as builds under a chosen service account must", () => {
    expect(load(file).options?.logging).toBe("CLOUD_LOGGING_ONLY");
  });

  it("installs from the lockfile, type-checks, tests, and builds through the size gate", () => {
    const config = load(file);
    expect(checkSteps(config)).toEqual(CHECKS);
    for (const step of config.steps.filter((s) => s.entrypoint === "corepack")) {
      expect(step.name).toBe("node:22-bookworm");
    }
  });

  it("uses only substitutions the build defines", () => {
    const config = load(file);
    const values = Object.fromEntries(
      [...BUILT_INS, ...Object.keys(config.substitutions ?? {})].map((name) => [name, "x"]),
    );
    for (const step of config.steps) {
      for (const text of [...(step.args ?? []), ...(step.env ?? [])]) {
        expect(() => substitute(text, values)).not.toThrow();
      }
    }
  });
});

describe("cloudbuild/pr.yaml", () => {
  it("runs the checks only: nothing is uploaded or deployed", () => {
    const config = load("pr.yaml");
    expect(config.steps.map((step) => step.id)).toEqual(CHECKS.map((check) => check.id));
    expect(readFileSync(join(root, "cloudbuild/pr.yaml"), "utf8")).not.toMatch(/gs:\/\/|cloudsdktool/);
  });
});

describe("cloudbuild/release.yaml", () => {
  let workspace: string;
  let fakeBin: string;
  let callLog: string;
  let buckets: string;
  // This build's dist/a.js.
  const BUILT = "(()=>{})();\n";

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "tag-release-"));
    workspace = join(dir, "workspace");
    fakeBin = join(dir, "bin");
    callLog = join(dir, "calls");
    buckets = join(dir, "gcs");
    mkdirSync(join(workspace, "scripts"), { recursive: true });
    mkdirSync(join(workspace, "dist"));
    mkdirSync(fakeBin);
    mkdirSync(buckets);
    copyFileSync(join(root, "scripts/release-version.mjs"), join(workspace, "scripts/release-version.mjs"));
    writeFileSync(join(workspace, "package.json"), JSON.stringify({ version: "0.3.0" }));
    writeFileSync(join(workspace, "dist/a.js"), BUILT);
    copyFileSync(join(root, "test/fake-gcloud.sh"), join(fakeBin, "gcloud"));
    chmodSync(join(fakeBin, "gcloud"), 0o755);
    writeFileSync(callLog, "");
  });

  /** Puts an object in the stand-in bucket, as an earlier build would have uploaded it. */
  function stored(name: string, contents: string): void {
    const path = join(buckets, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }

  /** The object's contents in the stand-in bucket. */
  function object(name: string): string {
    return readFileSync(join(buckets, name), "utf8");
  }

  afterEach(() => {
    rmSync(dirname(workspace), { recursive: true, force: true });
  });

  /** Runs the release's shell steps in order, as Cloud Build would, until one fails. */
  function release(values: { _ENV: string; TAG_NAME: string; SHORT_SHA: string }): {
    ran: string[];
    failed?: string;
    stderr?: string;
    calls: string[][];
  } {
    const config = load("release.yaml");
    const ran: string[] = [];
    let failure: { step: string; stderr: string } | undefined;
    for (const step of config.steps.filter((s) => s.entrypoint === "bash")) {
      const [flag, script] = step.args ?? [];
      expect(flag).toBe("-c");
      const env: Record<string, string> = {
        PATH: [fakeBin, dirname(process.execPath), process.env.PATH].join(":"),
        FAKE_GCLOUD_LOG: callLog,
        FAKE_GCS: buckets,
      };
      for (const pair of [...(config.options?.env ?? []), ...(step.env ?? [])]) {
        const [name, ...rest] = substitute(pair, values).split("=");
        env[name!] = rest.join("=");
      }
      try {
        execFileSync("bash", ["-c", substitute(script!, values)], { cwd: workspace, env, stdio: "pipe" });
      } catch (error) {
        failure = { step: step.id, stderr: String((error as { stderr?: Buffer }).stderr) };
        break;
      }
      ran.push(step.id);
    }
    const calls = readFileSync(callLog, "utf8")
      .split("\x1e")
      .filter((call) => call !== "")
      .map((call) => call.split("\x1f").slice(0, -1));
    return failure === undefined ? { ran, calls } : { ran, failed: failure.step, stderr: failure.stderr, calls };
  }

  const JS = "--content-type=text/javascript; charset=utf-8";

  /** The upload's hash check: this build's a.js, then the stored object. */
  function hashCalls(object: string): string[][] {
    return [
      ["storage", "hash", "dist/a.js", "--skip-md5", "--format=value(crc32c_hash)"],
      ["storage", "objects", "describe", object, "--format=value(crc32c_hash)"],
    ];
  }

  it("defaults to dev, and runs the checks before anything is uploaded", () => {
    const config = load("release.yaml");
    expect(config.substitutions).toEqual({ _ENV: "dev" });
    const ids = config.steps.map((step) => step.id);
    expect(ids).toEqual(["version", "install", "typecheck", "test", "build", "upload", "promote"]);
  });

  it("dev: uploads a.<version>.js, promotes it to a.js with the adapters, and purges both", () => {
    mkdirSync(join(workspace, "dist/adapters"));
    writeFileSync(join(workspace, "dist/adapters/example-cmp.js"), "(()=>{})();\n");

    const { ran, failed, calls } = release({ _ENV: "dev", TAG_NAME: "", SHORT_SHA: "abc1234" });

    expect(failed).toBeUndefined();
    expect(ran).toEqual(["version", "upload", "promote"]);
    const bucket = "gs://amandatrk-dev-data-static";
    expect(calls).toEqual([
      [
        "storage",
        "cp",
        "--no-clobber",
        "--cache-control=public, max-age=31536000, immutable",
        JS,
        "dist/a.js",
        `${bucket}/a.0.3.0-dev.gabc1234.js`,
      ],
      ...hashCalls(`${bucket}/a.0.3.0-dev.gabc1234.js`),
      ["storage", "cp", "--cache-control=public, max-age=300", JS, `${bucket}/a.0.3.0-dev.gabc1234.js`, `${bucket}/a.js`],
      ["storage", "cp", "--cache-control=public, max-age=300", JS, "dist/adapters/example-cmp.js", `${bucket}/adapters/`],
      ...["/a.js", "/adapters/*"].map((path) => [
        "compute",
        "url-maps",
        "invalidate-cdn-cache",
        "trk-collect-map",
        "--global",
        `--path=${path}`,
        "--project=amandatrk-dev-data",
      ]),
    ]);
    expect(object("amandatrk-dev-data-static/a.0.3.0-dev.gabc1234.js")).toBe(BUILT);
    expect(object("amandatrk-dev-data-static/a.js")).toBe(BUILT);
    expect(object("amandatrk-dev-data-static/adapters/example-cmp.js")).toBe("(()=>{})();\n");
  });

  it("dev without adapters: promotes and purges a.js alone", () => {
    const { failed, calls } = release({ _ENV: "dev", TAG_NAME: "", SHORT_SHA: "abc1234" });

    expect(failed).toBeUndefined();
    const copiesAndPurges = calls.filter((call) => call[1] !== "hash" && call[1] !== "objects");
    expect(copiesAndPurges.map((call) => call.slice(0, 3).concat(call.slice(-2)))).toEqual([
      ["storage", "cp", "--no-clobber", "dist/a.js", "gs://amandatrk-dev-data-static/a.0.3.0-dev.gabc1234.js"],
      [
        "storage",
        "cp",
        "--cache-control=public, max-age=300",
        "gs://amandatrk-dev-data-static/a.0.3.0-dev.gabc1234.js",
        "gs://amandatrk-dev-data-static/a.js",
      ],
      ["compute", "url-maps", "invalidate-cdn-cache", "--path=/a.js", "--project=amandatrk-dev-data"],
    ]);
  });

  it("prod: uploads the tagged a.<semver>.js only, and never touches a.js", () => {
    mkdirSync(join(workspace, "dist/adapters"));
    writeFileSync(join(workspace, "dist/adapters/example-cmp.js"), "(()=>{})();\n");

    const { ran, failed, calls } = release({ _ENV: "prod", TAG_NAME: "v0.3.0", SHORT_SHA: "abc1234" });

    expect(failed).toBeUndefined();
    expect(ran).toEqual(["version", "upload", "promote"]);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.slice(-2)).toEqual(["dist/a.js", "gs://amandatrk-prod-data-static/a.0.3.0.js"]);
    expect(calls.slice(1)).toEqual(hashCalls("gs://amandatrk-prod-data-static/a.0.3.0.js"));
    expect(object("amandatrk-prod-data-static/a.0.3.0.js")).toBe(BUILT);
  });

  it("a retried build finds its own bytes in a.<version>.js, leaves them in place, and goes on", () => {
    stored("amandatrk-prod-data-static/a.0.3.0.js", BUILT);

    const { ran, failed } = release({ _ENV: "prod", TAG_NAME: "v0.3.0", SHORT_SHA: "abc1234" });

    expect(failed).toBeUndefined();
    expect(ran).toEqual(["version", "upload", "promote"]);
    expect(object("amandatrk-prod-data-static/a.0.3.0.js")).toBe(BUILT);
  });

  it("another build of a version already uploaded fails, and leaves the first upload in place", () => {
    // v0.3.0 was uploaded, then its tag moved to a fix commit, with package.json still at 0.3.0.
    stored("amandatrk-prod-data-static/a.0.3.0.js", "(()=>{broken()})();\n");

    const { ran, failed, stderr } = release({ _ENV: "prod", TAG_NAME: "v0.3.0", SHORT_SHA: "def5678" });

    expect(ran).toEqual(["version"]);
    expect(failed).toBe("upload");
    expect(stderr).toContain("a.0.3.0.js already exists with other contents: bump the version");
    expect(object("amandatrk-prod-data-static/a.0.3.0.js")).toBe("(()=>{broken()})();\n");
  });

  it("dev: another build of the same version fails before a.js is promoted", () => {
    stored("amandatrk-dev-data-static/a.0.3.0-dev.gabc1234.js", "(()=>{broken()})();\n");
    stored("amandatrk-dev-data-static/a.js", "(()=>{previous()})();\n");

    const { failed, calls } = release({ _ENV: "dev", TAG_NAME: "", SHORT_SHA: "abc1234" });

    expect(failed).toBe("upload");
    expect(calls.some((call) => call[0] === "compute")).toBe(false);
    expect(object("amandatrk-dev-data-static/a.js")).toBe("(()=>{previous()})();\n");
  });

  it("prod without a release tag fails before anything is uploaded", () => {
    const { ran, failed, calls } = release({ _ENV: "prod", TAG_NAME: "", SHORT_SHA: "abc1234" });

    expect(ran).toEqual([]);
    expect(failed).toBe("version");
    expect(calls).toEqual([]);
  });

  it("a tag that disagrees with package.json fails before anything is uploaded", () => {
    const { failed, calls } = release({ _ENV: "prod", TAG_NAME: "v0.3.1", SHORT_SHA: "abc1234" });

    expect(failed).toBe("version");
    expect(calls).toEqual([]);
  });
});
