// The version a release publishes the tag under, as dist/a.<version>.js: cloudbuild/release.yaml
// runs it before uploading.
// - A release tag `v<semver>` publishes package.json's version, and the two must agree.
// - A dev build from a branch (every merge to main) publishes `<package version>-dev.g<short sha>`,
//   so each commit gets its own immutable object. The `g` keeps an all-digit sha from being a
//   numeric prerelease identifier, which semver forbids with a leading zero.
// - A prod build needs a release tag.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "../..");

// semver.org's 2.0.0 grammar, without build metadata: a `+` has no place in an object name.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

export const RELEASE_ENVS = ["dev", "prod"];

export class ReleaseVersionError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ReleaseVersionError";
  }
}

/**
 * @param {string} version
 * @returns {boolean}
 */
export function isSemver(version) {
  return SEMVER.test(version);
}

/**
 * @param {{ env: string, packageVersion: string, tagName?: string, shortSha?: string }} build
 * @returns {string} the version to publish
 */
export function releaseVersion({ env, packageVersion, tagName = "", shortSha = "" }) {
  if (!RELEASE_ENVS.includes(env)) {
    throw new ReleaseVersionError(`unknown release environment ${JSON.stringify(env)}: expected dev or prod`);
  }
  if (!isSemver(packageVersion)) {
    throw new ReleaseVersionError(`package.json version ${JSON.stringify(packageVersion)} is not semver`);
  }
  if (tagName !== "") {
    if (tagName !== `v${packageVersion}`) {
      throw new ReleaseVersionError(
        `release tag ${JSON.stringify(tagName)} does not match package.json version ${packageVersion}: expected v${packageVersion}`,
      );
    }
    return packageVersion;
  }
  if (env === "prod") {
    throw new ReleaseVersionError("a prod release builds only from a release tag v<semver>, and this build has none");
  }
  if (!/^[0-9a-f]{7,40}$/.test(shortSha)) {
    throw new ReleaseVersionError(`a dev release needs the commit's short sha, got ${JSON.stringify(shortSha)}`);
  }
  const separator = packageVersion.includes("-") ? "." : "-";
  const version = `${packageVersion}${separator}dev.g${shortSha}`;
  if (!isSemver(version)) throw new ReleaseVersionError(`${version} is not semver`);
  return version;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { version: packageVersion } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  try {
    console.log(
      releaseVersion({
        env: process.env.RELEASE_ENV ?? "",
        packageVersion,
        tagName: process.env.TAG_NAME ?? "",
        shortSha: process.env.SHORT_SHA ?? "",
      }),
    );
  } catch (error) {
    if (!(error instanceof ReleaseVersionError)) throw error;
    console.error(`release version: ${error.message}`);
    process.exit(1);
  }
}
