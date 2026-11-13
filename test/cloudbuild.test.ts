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

// The Node image every Node step runs in, pinned by digest so that a commit always runs the same one.
const NODE_IMAGE = /^node:22-bookworm@sha256:[0-9a-f]{64}$/;

const CHECKS = [
  { id: "install", args: ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"] },
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
  });

  it("runs every Node step in the same Node image, pinned by digest", () => {
    const nodeSteps = load(file).steps.filter((step) => step.name.startsWith("node:"));
    expect(nodeSteps.map((step) => step.id)).toEqual(
      file === "release.yaml" ? ["version", ...CHECKS.map((check) => check.id)] : CHECKS.map((check) => check.id),
    );
    for (const step of nodeSteps) expect(step.name).toMatch(NODE_IMAGE);
    expect(new Set(nodeSteps.map((step) => step.name)).size).toBe(1);
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

it("package.json pins pnpm, the version corepack runs in every build, by its hash", () => {
  const { packageManager } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    packageManager: string;
  };
  expect(packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/);
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

  let origin: string;

  // Every commit's time, two hours east of UTC, so that a dev version shows it converted to UTC.
  const COMMITTED = "2026-11-13T20:53:00+02:00";
  // A dev build of package.json's 0.3.0 at that commit: the next patch, the commit's UTC time, its sha.
  const DEV_VERSION = "0.3.1-dev.20261113185300.gabc1234";

  /** Runs git in `cwd`, with a committer and a commit time of its own, and returns its output. */
  function git(cwd: string, ...args: string[]): string {
    const ident = { GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_AUTHOR_DATE: COMMITTED };
    const committer = {
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_COMMITTER_DATE: COMMITTED,
    };
    return execFileSync("git", args, {
      cwd,
      env: { ...process.env, ...ident, ...committer },
      stdio: "pipe",
    })
      .toString("utf8")
      .trim();
  }

  /** The build's checkout: a clone of origin with the release tag v0.3.0 checked out, as Cloud Build's. */
  function checkout(...cloneArgs: string[]): void {
    rmSync(workspace, { recursive: true, force: true });
    git(dirname(workspace), "clone", "--quiet", ...cloneArgs, `file://${origin}`, workspace);
    git(workspace, "-c", "advice.detachedHead=false", "checkout", "--quiet", "v0.3.0");
    mkdirSync(join(workspace, "scripts"), { recursive: true });
    mkdirSync(join(workspace, "dist"), { recursive: true });
    for (const script of ["release-version.mjs", "cli.mjs"]) {
      copyFileSync(join(root, "scripts", script), join(workspace, "scripts", script));
    }
    writeFileSync(join(workspace, "package.json"), JSON.stringify({ version: "0.3.0" }));
    writeFileSync(join(workspace, "dist/a.js"), BUILT);
  }

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "tag-release-"));
    workspace = join(dir, "workspace");
    fakeBin = join(dir, "bin");
    callLog = join(dir, "calls");
    buckets = join(dir, "gcs");
    // origin: main has the release commit, tagged v0.3.0, and a later one, so the tag isn't main's tip.
    origin = join(dir, "origin.git");
    const seed = join(dir, "seed");
    mkdirSync(seed);
    git(seed, "init", "--quiet", "-b", "main");
    git(seed, "commit", "--quiet", "--allow-empty", "-m", "chore(release): 0.3.0");
    git(seed, "tag", "v0.3.0");
    git(seed, "commit", "--quiet", "--allow-empty", "-m", "feat: after 0.3.0");
    git(dir, "clone", "--quiet", "--bare", seed, origin);
    checkout();
    mkdirSync(fakeBin);
    mkdirSync(buckets);
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
    status?: number;
    stderr?: string;
    calls: string[][];
  } {
    const config = load("release.yaml");
    const ran: string[] = [];
    let failure: { step: string; status: number; stderr: string } | undefined;
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
        // Only a step that ran and exited non-zero is a failed step; bash not starting is the test's own error.
        const { status, stderr } = error as { status?: number | null; stderr?: Buffer };
        if (typeof status !== "number" || stderr === undefined) throw error;
        failure = { step: step.id, status, stderr: stderr.toString("utf8") };
        break;
      }
      ran.push(step.id);
    }
    const calls = readFileSync(callLog, "utf8")
      .split("\x1e")
      .filter((call) => call !== "")
      .map((call) => call.split("\x1f").slice(0, -1));
    return failure === undefined
      ? { ran, calls }
      : { ran, failed: failure.step, status: failure.status, stderr: failure.stderr, calls };
  }

  const JS = "--content-type=text/javascript; charset=utf-8";

  const IMMUTABLE = "--cache-control=public, max-age=31536000, immutable";

  /** The upload of one immutable file: the copy, then its hash check, the file's and the object's. */
  function uploadCalls(file: string, object: string): string[][] {
    return [
      ["storage", "cp", "--no-clobber", IMMUTABLE, JS, file, object],
      ["storage", "hash", file, "--skip-md5", "--format=value(crc32c_hash)"],
      ["storage", "objects", "describe", object, "--format=value(crc32c_hash)"],
    ];
  }

  // This build's adapters, in dist/adapters/.
  const ADAPTER = "(()=>{adapter()})();\n";

  function withAdapters(...names: string[]): void {
    mkdirSync(join(workspace, "dist/adapters"));
    for (const name of names) writeFileSync(join(workspace, "dist/adapters", `${name}.js`), ADAPTER);
  }

  it("defaults to dev, and runs the checks before anything is uploaded", () => {
    const config = load("release.yaml");
    expect(config.substitutions).toEqual({ _ENV: "dev" });
    const ids = config.steps.map((step) => step.id);
    expect(ids).toEqual(["version", "install", "typecheck", "test", "build", "upload", "promote"]);
  });

  it("dev: uploads the version's adapters, then a.<version>.js, promotes it to a.js and purges that", () => {
    withAdapters("example-cmp", "other-cmp");

    const { ran, failed, calls } = release({ _ENV: "dev", TAG_NAME: "", SHORT_SHA: "abc1234" });

    expect(failed).toBeUndefined();
    expect(ran).toEqual(["version", "upload", "promote"]);
    const bucket = "gs://amandatrk-dev-data-static";
    expect(calls).toEqual([
      ...uploadCalls("dist/adapters/example-cmp.js", `${bucket}/adapters/${DEV_VERSION}/example-cmp.js`),
      ...uploadCalls("dist/adapters/other-cmp.js", `${bucket}/adapters/${DEV_VERSION}/other-cmp.js`),
      ...uploadCalls("dist/a.js", `${bucket}/a.${DEV_VERSION}.js`),
      ["storage", "cp", "--cache-control=public, max-age=300", JS, `${bucket}/a.${DEV_VERSION}.js`, `${bucket}/a.js`],
      [
        "compute",
        "url-maps",
        "invalidate-cdn-cache",
        "trk-collect-map",
        "--global",
        "--path=/a.js",
        "--project=amandatrk-dev-data",
      ],
    ]);
    expect(object(`amandatrk-dev-data-static/a.${DEV_VERSION}.js`)).toBe(BUILT);
    expect(object("amandatrk-dev-data-static/a.js")).toBe(BUILT);
    expect(object(`amandatrk-dev-data-static/adapters/${DEV_VERSION}/example-cmp.js`)).toBe(ADAPTER);
    expect(object(`amandatrk-dev-data-static/adapters/${DEV_VERSION}/other-cmp.js`)).toBe(ADAPTER);
  });

  it("dev without adapters: promotes and purges a.js alone", () => {
    const { failed, calls } = release({ _ENV: "dev", TAG_NAME: "", SHORT_SHA: "abc1234" });

    expect(failed).toBeUndefined();
    const copiesAndPurges = calls.filter((call) => call[1] !== "hash" && call[1] !== "objects");
    expect(copiesAndPurges.map((call) => call.slice(0, 3).concat(call.slice(-2)))).toEqual([
      ["storage", "cp", "--no-clobber", "dist/a.js", `gs://amandatrk-dev-data-static/a.${DEV_VERSION}.js`],
      [
        "storage",
        "cp",
        "--cache-control=public, max-age=300",
        `gs://amandatrk-dev-data-static/a.${DEV_VERSION}.js`,
        "gs://amandatrk-dev-data-static/a.js",
      ],
      ["compute", "url-maps", "invalidate-cdn-cache", "--path=/a.js", "--project=amandatrk-dev-data"],
    ]);
  });

  it("prod: uploads the tagged release's adapters and a.<semver>.js only, and never touches a.js", () => {
    withAdapters("example-cmp");

    const { ran, failed, calls } = release({ _ENV: "prod", TAG_NAME: "v0.3.0", SHORT_SHA: "abc1234" });

    expect(failed).toBeUndefined();
    expect(ran).toEqual(["version", "upload", "promote"]);
    const bucket = "gs://amandatrk-prod-data-static";
    expect(calls).toEqual([
      ...uploadCalls("dist/adapters/example-cmp.js", `${bucket}/adapters/0.3.0/example-cmp.js`),
      ...uploadCalls("dist/a.js", `${bucket}/a.0.3.0.js`),
    ]);
    expect(object("amandatrk-prod-data-static/adapters/0.3.0/example-cmp.js")).toBe(ADAPTER);
    expect(object("amandatrk-prod-data-static/a.0.3.0.js")).toBe(BUILT);
  });

  it("another build of a version whose adapter differs fails before the core is uploaded", () => {
    withAdapters("example-cmp");
    stored("amandatrk-prod-data-static/adapters/0.3.0/example-cmp.js", "(()=>{oldAdapter()})();\n");

    const { failed, stderr, calls } = release({ _ENV: "prod", TAG_NAME: "v0.3.0", SHORT_SHA: "def5678" });

    expect(failed).toBe("upload");
    expect(stderr).toContain("adapters/0.3.0/example-cmp.js already exists with other contents: bump the version");
    expect(calls.some((call) => call.includes("dist/a.js"))).toBe(false);
    expect(object("amandatrk-prod-data-static/adapters/0.3.0/example-cmp.js")).toBe("(()=>{oldAdapter()})();\n");
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
    stored(`amandatrk-dev-data-static/a.${DEV_VERSION}.js`, "(()=>{broken()})();\n");
    stored("amandatrk-dev-data-static/a.js", "(()=>{previous()})();\n");

    const { failed, calls } = release({ _ENV: "dev", TAG_NAME: "", SHORT_SHA: "abc1234" });

    expect(failed).toBe("upload");
    expect(calls.some((call) => call[0] === "compute")).toBe(false);
    expect(object("amandatrk-dev-data-static/a.js")).toBe("(()=>{previous()})();\n");
  });

  it("prod without a release tag fails before anything is uploaded", () => {
    const { ran, failed, status, stderr, calls } = release({ _ENV: "prod", TAG_NAME: "", SHORT_SHA: "abc1234" });

    expect(ran).toEqual([]);
    expect(failed).toBe("version");
    // The script's own refusal, and not a crash of it or a missing `node`, both of which also fail the step.
    expect(status).toBe(1);
    expect(stderr).toBe(
      "release version: a prod release builds only from a release tag v<semver>, and this build has none\n",
    );
    expect(calls).toEqual([]);
  });

  it("a tag that disagrees with package.json fails before anything is uploaded", () => {
    const { failed, status, stderr, calls } = release({ _ENV: "prod", TAG_NAME: "v0.3.1", SHORT_SHA: "abc1234" });

    expect(failed).toBe("version");
    expect(status).toBe(1);
    expect(stderr).toBe(
      'release version: release tag "v0.3.1" does not match package.json version 0.3.0: expected v0.3.0\n',
    );
    expect(calls).toEqual([]);
  });

  it("prod: a release tag on a commit that isn't on main fails before anything is uploaded", () => {
    // v0.3.0 moved to a commit pushed to another branch, never merged to main.
    git(workspace, "checkout", "--quiet", "-b", "hotfix");
    git(workspace, "commit", "--quiet", "--allow-empty", "-m", "fix: not on main");
    git(workspace, "push", "--quiet", "origin", "hotfix");
    const head = git(workspace, "rev-parse", "HEAD");

    const { ran, failed, status, stderr, calls } = release({ _ENV: "prod", TAG_NAME: "v0.3.0", SHORT_SHA: "def5678" });

    expect(ran).toEqual([]);
    expect(failed).toBe("version");
    expect(status).toBe(1);
    expect(stderr).toBe(`release v0.3.0: commit ${head} is not on main; a prod release builds only from main\n`);
    expect(calls).toEqual([]);
  });

  it("prod: a shallow checkout of a release tag on main fetches main's history and goes on", () => {
    // Only the tagged commit, with no main branch: the checkout a tag trigger may give.
    checkout("--depth", "1", "--branch", "v0.3.0");
    expect(git(workspace, "rev-parse", "--is-shallow-repository")).toBe("true");

    const { ran, failed } = release({ _ENV: "prod", TAG_NAME: "v0.3.0", SHORT_SHA: "abc1234" });

    expect(failed).toBeUndefined();
    expect(ran).toEqual(["version", "upload", "promote"]);
    expect(git(workspace, "rev-parse", "--is-shallow-repository")).toBe("false");
  });

  it("dev: builds from main without checking the commit against origin", () => {
    // A dev build runs on a push to main; it never fetches, so it can't fail on reaching origin.
    rmSync(origin, { recursive: true });

    const { ran, failed } = release({ _ENV: "dev", TAG_NAME: "", SHORT_SHA: "abc1234" });

    expect(failed).toBeUndefined();
    expect(ran).toEqual(["version", "upload", "promote"]);
  });

  it("dev: a retried build of the same commit publishes the same version, and finds its own bytes", () => {
    expect(release({ _ENV: "dev", TAG_NAME: "", SHORT_SHA: "abc1234" }).failed).toBeUndefined();
    writeFileSync(callLog, "");

    const { ran, failed, calls } = release({ _ENV: "dev", TAG_NAME: "", SHORT_SHA: "abc1234" });

    expect(failed).toBeUndefined();
    expect(ran).toEqual(["version", "upload", "promote"]);
    expect(calls[0]).toContain(`gs://amandatrk-dev-data-static/a.${DEV_VERSION}.js`);
    expect(object(`amandatrk-dev-data-static/a.${DEV_VERSION}.js`)).toBe(BUILT);
  });

  it("dev: a shallow checkout still has the commit's time", () => {
    checkout("--depth", "1", "--branch", "v0.3.0");
    expect(git(workspace, "rev-parse", "--is-shallow-repository")).toBe("true");

    const { failed } = release({ _ENV: "dev", TAG_NAME: "", SHORT_SHA: "abc1234" });

    expect(failed).toBeUndefined();
    expect(readFileSync(join(workspace, ".release-version"), "utf8")).toBe(`${DEV_VERSION}\n`);
  });

  it("dev: a checkout without .git fails before anything is uploaded, rather than take the build's time", () => {
    rmSync(join(workspace, ".git"), { recursive: true });

    const { ran, failed, status, stderr, calls } = release({ _ENV: "dev", TAG_NAME: "", SHORT_SHA: "abc1234" });

    expect(ran).toEqual([]);
    expect(failed).toBe("version");
    expect(status).toBe(1);
    expect(stderr).toContain("dev release: the checkout has no git history to take the commit's time from\n");
    expect(calls).toEqual([]);
  });
});
