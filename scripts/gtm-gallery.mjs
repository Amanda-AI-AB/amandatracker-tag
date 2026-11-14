// Checks the Google Tag Manager Community Template Gallery's package (AAI-156): metadata.yaml's
// shape, and that each version it lists is a commit on main whose template.tpl the gallery can
// publish, the newest being the template.tpl of this checkout. See docs/gtm-gallery.md.
//
//   pnpm gtm:check [--ref <ref>]   # <ref> is the branch the gallery reads, origin/main by default
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { ROOT, runMain } from "./cli.mjs";

export class GalleryError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "GalleryError";
  }
}

/** @typedef {{ sha: string, changeNotes: string }} GalleryVersion */
/** @typedef {{ homepage: string, documentation: string, versions: GalleryVersion[] }} GalleryMetadata */

const KEYS = ["homepage", "documentation", "versions"];
const VERSION_KEYS = ["sha", "changeNotes"];

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} record
 * @param {string[]} allowed
 * @param {string} where
 */
function onlyKeys(record, allowed, where) {
  const extra = Object.keys(record).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new GalleryError(`${where} has unknown keys: ${extra.join(", ")}`);
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
function httpsUrl(value, name) {
  if (typeof value !== "string" || !/^https:\/\/[^\s/]+\.[^\s/]+(\/\S*)?$/.test(value)) {
    throw new GalleryError(`${name} must be an https URL, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * metadata.yaml, parsed and checked against the gallery's format.
 * @param {string} text
 * @returns {GalleryMetadata}
 */
export function parseMetadata(text) {
  const doc = parse(text);
  if (!isRecord(doc)) throw new GalleryError("metadata.yaml must be a mapping");
  onlyKeys(doc, KEYS, "metadata.yaml");
  const homepage = httpsUrl(doc.homepage, "homepage");
  const documentation = httpsUrl(doc.documentation, "documentation");
  if (!Array.isArray(doc.versions) || doc.versions.length === 0) {
    throw new GalleryError("versions must list at least one version");
  }
  /** @type {GalleryVersion[]} */
  const versions = doc.versions.map((entry, i) => {
    const where = `versions[${i}]`;
    if (!isRecord(entry)) throw new GalleryError(`${where} must be a mapping`);
    onlyKeys(entry, VERSION_KEYS, where);
    const { sha, changeNotes } = entry;
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new GalleryError(`${where}.sha must be a full 40-character commit sha, got ${JSON.stringify(sha)}`);
    }
    if (typeof changeNotes !== "string" || changeNotes.trim() === "") {
      throw new GalleryError(`${where}.changeNotes must be a non-empty string`);
    }
    return { sha, changeNotes };
  });
  const seen = new Set();
  for (const { sha } of versions) {
    if (seen.has(sha)) throw new GalleryError(`version ${sha} is listed twice`);
    seen.add(sha);
  }
  return { homepage, documentation, versions };
}

/**
 * @typedef {object} History
 * @property {(ancestor: string, descendant: string) => boolean} isAncestor
 *   whether `ancestor` is reachable from `descendant`; an unknown commit throws
 * @property {(sha: string, path: string) => string | null} fileAt the file's text at a commit, or null when it has none
 */

/**
 * Checks the versions against the repo's history: each on `ref`, newest first, each with a
 * template.tpl, and the newest's being `template`, the checkout's.
 * @param {GalleryMetadata} metadata
 * @param {History} history
 * @param {string} ref
 * @param {string} template
 */
export function checkHistory(metadata, history, ref, template) {
  const { versions } = metadata;
  versions.forEach(({ sha }, i) => {
    if (!history.isAncestor(sha, ref)) throw new GalleryError(`version ${sha} is not on ${ref}`);
    if (history.fileAt(sha, "template.tpl") === null) throw new GalleryError(`version ${sha} has no template.tpl`);
    const newer = versions[i - 1];
    if (newer !== undefined && !history.isAncestor(sha, newer.sha)) {
      throw new GalleryError(`version ${sha} is listed after ${newer.sha}, which doesn't descend from it: list the newest first`);
    }
  });
  const latest = /** @type {GalleryVersion} */ (versions[0]);
  if (history.fileAt(latest.sha, "template.tpl") !== template) {
    throw new GalleryError(
      `template.tpl has changed since the newest version, ${latest.sha}: once the change is on main, list its commit first`,
    );
  }
}

/**
 * git, run in `cwd`.
 * @param {string} cwd
 * @returns {History}
 */
export function gitHistory(cwd) {
  /** @param {string[]} args */
  const git = (args) => spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    isAncestor(ancestor, descendant) {
      const result = git(["merge-base", "--is-ancestor", ancestor, descendant]);
      if (result.error !== undefined) throw result.error;
      if (result.status === 0) return true;
      if (result.status === 1) return false;
      throw new GalleryError(`git merge-base ${ancestor} ${descendant}: ${result.stderr.trim()}`);
    },
    fileAt(sha, path) {
      const exists = git(["cat-file", "-e", `${sha}:${path}`]);
      if (exists.error !== undefined) throw exists.error;
      if (exists.status !== 0) return null;
      const shown = git(["show", `${sha}:${path}`]);
      if (shown.error !== undefined) throw shown.error;
      if (shown.status !== 0) throw new GalleryError(`git show ${sha}:${path}: ${shown.stderr.trim()}`);
      return shown.stdout;
    },
  };
}

await runMain(
  import.meta.url,
  () => {
    const args = process.argv.slice(2);
    const at = args.indexOf("--ref");
    const ref = at === -1 ? "origin/main" : args[at + 1];
    if (ref === undefined || (at === -1 && args.length > 0) || (at !== -1 && args.length !== 2)) {
      throw new GalleryError("usage: pnpm gtm:check [--ref <ref>]");
    }
    const metadata = parseMetadata(readFileSync(join(ROOT, "metadata.yaml"), "utf8"));
    checkHistory(metadata, gitHistory(ROOT), ref, readFileSync(join(ROOT, "template.tpl"), "utf8"));
    console.log(`metadata.yaml: ${metadata.versions.length} version(s) on ${ref}, the newest being this template.tpl`);
  },
  [[GalleryError, "gtm gallery"]],
);
