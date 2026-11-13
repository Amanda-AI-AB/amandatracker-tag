import { describe, expect, it } from "vitest";
import { isSemver, releaseVersion, ReleaseVersionError } from "../scripts/release-version.mjs";

describe("releaseVersion", () => {
  it("publishes package.json's version on its release tag", () => {
    expect(releaseVersion({ env: "prod", packageVersion: "1.2.3", tagName: "v1.2.3" })).toBe("1.2.3");
    expect(releaseVersion({ env: "dev", packageVersion: "1.2.3", tagName: "v1.2.3", shortSha: "abc1234" })).toBe(
      "1.2.3",
    );
  });

  it("refuses a tag that doesn't match package.json", () => {
    expect(() => releaseVersion({ env: "prod", packageVersion: "1.2.3", tagName: "v1.2.4" })).toThrow(
      /does not match package.json version 1.2.3/,
    );
    expect(() => releaseVersion({ env: "prod", packageVersion: "1.2.3", tagName: "1.2.3" })).toThrow(
      ReleaseVersionError,
    );
  });

  it("refuses a prod build without a release tag", () => {
    expect(() => releaseVersion({ env: "prod", packageVersion: "1.2.3", shortSha: "abc1234" })).toThrow(
      /only from a release tag/,
    );
  });

  it("gives each dev build from a branch its own prerelease version", () => {
    expect(releaseVersion({ env: "dev", packageVersion: "0.0.0", shortSha: "7bc470e" })).toBe("0.0.0-dev.g7bc470e");
    expect(releaseVersion({ env: "dev", packageVersion: "0.1.0-rc.1", shortSha: "7bc470e" })).toBe(
      "0.1.0-rc.1.dev.g7bc470e",
    );
  });

  it("keeps an all-digit sha with a leading zero valid semver", () => {
    const version = releaseVersion({ env: "dev", packageVersion: "0.0.0", shortSha: "0123456" });
    expect(version).toBe("0.0.0-dev.g0123456");
    expect(isSemver(version)).toBe(true);
    expect(isSemver("0.0.0-dev.0123456")).toBe(false);
  });

  it("refuses a dev build without a commit sha", () => {
    expect(() => releaseVersion({ env: "dev", packageVersion: "0.0.0" })).toThrow(/short sha/);
    expect(() => releaseVersion({ env: "dev", packageVersion: "0.0.0", shortSha: "main" })).toThrow(/short sha/);
  });

  it("refuses an unknown environment or a version that isn't semver", () => {
    expect(() => releaseVersion({ env: "", packageVersion: "0.0.0", shortSha: "abc1234" })).toThrow(
      /unknown release environment/,
    );
    expect(() => releaseVersion({ env: "staging", packageVersion: "0.0.0", shortSha: "abc1234" })).toThrow(
      ReleaseVersionError,
    );
    expect(() => releaseVersion({ env: "dev", packageVersion: "1.0", shortSha: "abc1234" })).toThrow(/not semver/);
  });
});
