import { describe, expect, it } from "vitest";
import { isSemver, releaseVersion, ReleaseVersionError } from "../scripts/release-version.mjs";

/** Semver 2.0.0 precedence (§11), for versions without build metadata. */
function compareSemver(a: string, b: string): number {
  const split = (version: string): [string[], string[]] => {
    const [core, ...prerelease] = version.split("-");
    return [core!.split("."), prerelease.length === 0 ? [] : prerelease.join("-").split(".")];
  };
  const numeric = (id: string): boolean => /^\d+$/.test(id);
  const compareIds = (x: string, y: string): number => {
    if (numeric(x) && numeric(y)) return Math.sign(Number(x) - Number(y));
    if (numeric(x) !== numeric(y)) return numeric(x) ? -1 : 1;
    return x < y ? -1 : x > y ? 1 : 0;
  };
  const [coreA, preA] = split(a);
  const [coreB, preB] = split(b);
  for (let i = 0; i < 3; i++) {
    const order = compareIds(coreA[i]!, coreB[i]!);
    if (order !== 0) return order;
  }
  if (preA.length === 0 || preB.length === 0) return preB.length - preA.length;
  for (let i = 0; i < Math.min(preA.length, preB.length); i++) {
    const order = compareIds(preA[i]!, preB[i]!);
    if (order !== 0) return order;
  }
  return preA.length - preB.length;
}

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

  const TIME = "20261113185300";

  it("gives each dev build from a branch its own prerelease version of the next patch", () => {
    expect(releaseVersion({ env: "dev", packageVersion: "0.0.0", shortSha: "7bc470e", commitTime: TIME })).toBe(
      "0.0.1-dev.20261113185300.g7bc470e",
    );
    expect(releaseVersion({ env: "dev", packageVersion: "1.2.9", shortSha: "7bc470e", commitTime: TIME })).toBe(
      "1.2.10-dev.20261113185300.g7bc470e",
    );
  });

  it("keeps a prerelease package version, which already sorts before what follows it", () => {
    expect(releaseVersion({ env: "dev", packageVersion: "0.1.0-rc.1", shortSha: "7bc470e", commitTime: TIME })).toBe(
      "0.1.0-rc.1.dev.20261113185300.g7bc470e",
    );
  });

  it("sorts a dev build after the release it follows, and dev builds by their commit's time", () => {
    const release = "0.2.0";
    const earlier = releaseVersion({ env: "dev", packageVersion: release, shortSha: "fff0000", commitTime: TIME });
    const later = releaseVersion({
      env: "dev",
      packageVersion: release,
      shortSha: "0000fff",
      commitTime: "20261114090000",
    });
    expect([later, release, earlier].sort(compareSemver)).toEqual([release, earlier, later]);
  });

  it("keeps an all-digit sha with a leading zero valid semver", () => {
    const version = releaseVersion({ env: "dev", packageVersion: "0.0.0", shortSha: "0123456", commitTime: TIME });
    expect(version).toBe("0.0.1-dev.20261113185300.g0123456");
    expect(isSemver(version)).toBe(true);
    expect(isSemver("0.0.1-dev.20261113185300.0123456")).toBe(false);
  });

  it("refuses a dev build without a commit sha", () => {
    expect(() => releaseVersion({ env: "dev", packageVersion: "0.0.0", commitTime: TIME })).toThrow(/short sha/);
    expect(() => releaseVersion({ env: "dev", packageVersion: "0.0.0", shortSha: "main", commitTime: TIME })).toThrow(
      /short sha/,
    );
  });

  it("refuses a dev build without its commit's UTC time", () => {
    expect(() => releaseVersion({ env: "dev", packageVersion: "0.0.0", shortSha: "abc1234" })).toThrow(
      /commit's UTC time as YYYYMMDDHHMMSS, got ""/,
    );
    for (const commitTime of ["2026-11-13T18:53:00Z", "202611131853", "02026111318530", "1763059980"]) {
      expect(() => releaseVersion({ env: "dev", packageVersion: "0.0.0", shortSha: "abc1234", commitTime })).toThrow(
        ReleaseVersionError,
      );
    }
  });

  it("needs no commit time for a release tag", () => {
    expect(releaseVersion({ env: "dev", packageVersion: "1.2.3", tagName: "v1.2.3", shortSha: "abc1234" })).toBe(
      "1.2.3",
    );
  });

  it("refuses an unknown environment or a version that isn't semver", () => {
    expect(() => releaseVersion({ env: "", packageVersion: "0.0.0", shortSha: "abc1234", commitTime: TIME })).toThrow(
      /unknown release environment/,
    );
    expect(() =>
      releaseVersion({ env: "staging", packageVersion: "0.0.0", shortSha: "abc1234", commitTime: TIME }),
    ).toThrow(ReleaseVersionError);
    expect(() => releaseVersion({ env: "dev", packageVersion: "1.0", shortSha: "abc1234", commitTime: TIME })).toThrow(
      /not semver/,
    );
  });
});
