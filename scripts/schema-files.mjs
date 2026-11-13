// The wire JSON Schema's files: schema/v<N>/*.json, each with the $id SCHEMA_BASE/v<N>/<file>.
// gen-wire.mjs, schema-dist.mjs and the tests' validator list and load them through here.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./cli.mjs";

export const SCHEMA_ROOT = join(ROOT, "schema");
export const SCHEMA_BASE = "https://github.com/Amanda-AI-AB/amandatracker-tag/schema";

/**
 * @param {string} schemaRoot
 * @returns {number[]} the schema versions there, ascending
 */
export function schemaVersions(schemaRoot = SCHEMA_ROOT) {
  return readdirSync(schemaRoot)
    .map((name) => /^v([1-9][0-9]*)$/.exec(name))
    .filter((match) => match !== null)
    .map((match) => Number(match[1]))
    .sort((a, b) => a - b);
}

/**
 * @param {string} versionDir a schema/v<N> directory
 * @returns {string[]} its schema files' names, sorted
 */
export function schemaFiles(versionDir) {
  return readdirSync(versionDir)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

/**
 * @param {string} versionDir a schema/v<N> directory
 * @returns {Map<string, any>} each of its schemas, parsed, by file name, sorted
 */
export function loadSchemas(versionDir) {
  return new Map(schemaFiles(versionDir).map((name) => [name, JSON.parse(readFileSync(join(versionDir, name), "utf8"))]));
}
