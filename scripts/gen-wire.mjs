// Generates src/wire/generated.ts from the newest wire JSON Schema in schema/v<N>/: a TypeScript
// type for each schema and each of its $defs, and, for each object with properties (a schema's
// top-level object or an object in $defs), its field list, its required fields, its strings' length caps and a shape that
// ties in its nested objects' shapes, which the payload builder uses. The schema is the source of
// truth; a test fails when the committed file differs from what this generates.
//
// It covers the subset of JSON Schema the wire uses (object, string, integer, boolean, const,
// enum, oneOf, $ref) and throws on anything else, rather than generate a looser type.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "../..");
export const SCHEMA_ROOT = join(root, "schema");
export const GENERATED_FILE = join(root, "src/wire/generated.ts");

// Keywords that only document or constrain values, and change no TypeScript type.
const ANNOTATIONS = new Set([
  "$schema", "$id", "$defs", "title", "description", "minLength", "maxLength", "pattern", "minimum",
]);
// Keywords the generator turns into types.
const TYPED = new Set(["type", "const", "enum", "oneOf", "$ref", "properties", "required", "additionalProperties"]);

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

/** @param {string} name */
function screaming(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

/**
 * @param {string} versionDir
 * @returns {string} the contents of generated.ts
 */
export function generate(versionDir) {
  const files = readdirSync(versionDir).filter((name) => name.endsWith(".json")).sort();
  /** @type {Map<string, any>} */
  const schemas = new Map(files.map((name) => [name, JSON.parse(readFileSync(join(versionDir, name), "utf8"))]));

  /**
   * @param {string} file
   * @param {string} ref
   * @returns {{ name: string, schema: any }}
   */
  function resolveRef(file, ref) {
    const [target, pointer = ""] = ref.split("#");
    const targetFile = target || file;
    const schema = schemas.get(targetFile);
    if (!schema) throw new Error(`${file}: $ref ${ref} names no schema in ${versionDir}`);
    if (pointer === "") return { name: schema.title, schema };
    const name = /^\/\$defs\/([A-Za-z0-9]+)$/.exec(pointer)?.[1];
    const def = name === undefined ? undefined : schema.$defs?.[name];
    if (name === undefined || !def) throw new Error(`${file}: $ref ${ref} resolves to nothing`);
    return { name, schema: def };
  }

  /**
   * @param {string} file
   * @param {any} node
   * @returns {string} a TypeScript type
   */
  function typeOf(file, node) {
    for (const key of Object.keys(node)) {
      if (!ANNOTATIONS.has(key) && !TYPED.has(key)) throw new Error(`${file}: unsupported keyword ${key}`);
    }
    if (node.$ref) return resolveRef(file, node.$ref).name;
    if ("const" in node) return JSON.stringify(node.const);
    if (node.enum) return node.enum.map((/** @type {unknown} */ value) => JSON.stringify(value)).join(" | ");
    if (node.oneOf) return node.oneOf.map((/** @type {any} */ branch) => typeOf(file, branch)).join(" | ");
    switch (node.type) {
      case "string":
        return "string";
      case "integer":
      case "number":
        return "number";
      case "boolean":
        return "boolean";
      case "object":
        if (node.properties) throw new Error(`${file}: name a nested object in $defs`);
        return "Record<string, unknown>";
      default:
        throw new Error(`${file}: unsupported type ${JSON.stringify(node.type)}`);
    }
  }

  /**
   * @param {string} file
   * @param {any} node
   * @returns {any} the node, or the string schema a $ref names
   */
  function deref(file, node) {
    return node.$ref ? resolveRef(file, node.$ref).schema : node;
  }

  /**
   * @param {string} file
   * @param {string} name
   * @param {any} node
   */
  function declaration(file, name, node) {
    const doc = node.description ? `/** ${node.description} */\n` : "";
    if (node.type === "object" && node.properties) {
      if (node.additionalProperties !== false) throw new Error(`${file}: ${name} must set additionalProperties: false`);
      const required = new Set(node.required ?? []);
      const fields = Object.entries(node.properties).map(([key, prop]) => {
        const fieldDoc = /** @type {any} */ (prop).description ? `  /** ${/** @type {any} */ (prop).description} */\n` : "";
        return `${fieldDoc}  ${key}${required.has(key) ? "" : "?"}: ${typeOf(file, prop)};`;
      });
      return `${doc}export interface ${name} {\n${fields.join("\n")}\n}`;
    }
    return `${doc}export type ${name} = ${typeOf(file, node)};`;
  }

  /**
   * An object's shape, for the payload builder: its prefix, whether it has length caps, and the
   * properties that are nested objects, each with the name of the object they hold.
   * @type {Map<string, { prefix: string, capped: boolean, nested: [string, string][] }>}
   */
  const shapes = new Map();

  /**
   * The field list and the strings' length caps of an object with properties, and its shape.
   * @param {string} file
   * @param {string} name
   * @param {any} node
   * @returns {string[]}
   */
  function constants(file, name, node) {
    const prefix = screaming(name);
    const keys = Object.keys(node.properties);
    /** @type {string[]} */
    const required = node.required ?? [];
    for (const key of required) {
      if (!keys.includes(key)) throw new Error(`${file}: ${name} requires ${key}, which it doesn't list`);
    }
    const lines = [
      "",
      `export const ${prefix}_FIELDS = [${keys.map((key) => JSON.stringify(key)).join(", ")}] as const;`,
      "",
      `export const ${prefix}_REQUIRED = [${required.map((key) => JSON.stringify(key)).join(", ")}] as const;`,
    ];
    const caps = keys
      .map((key) => [key, deref(file, node.properties[key])])
      .filter(([, prop]) => prop.type === "string" && typeof prop.maxLength === "number")
      .map(([key, prop]) => `${key}: ${prop.maxLength}`);
    if (caps.length > 0) lines.push("", `export const ${prefix}_MAX_LENGTH = { ${caps.join(", ")} } as const;`);
    /** @type {[string, string][]} */
    const nested = [];
    for (const key of keys) {
      const ref = node.properties[key].$ref;
      if (!ref) continue;
      const target = resolveRef(file, ref);
      if (target.schema.type === "object" && target.schema.properties) nested.push([key, target.name]);
    }
    if (shapes.has(name)) throw new Error(`${file}: ${name} is named twice`);
    shapes.set(name, { prefix, capped: caps.length > 0, nested });
    return lines;
  }

  const out = [
    `// Generated by scripts/gen-wire.mjs from schema/${versionDir.split(/[\\/]/).pop()}/. Do not edit: change the`,
    "// schema and run `pnpm gen:wire`.",
  ];
  /** @type {Set<unknown>} */
  const versions = new Set();
  for (const [file, schema] of schemas) {
    versions.add(schema.properties?.schema_version?.const);
    out.push("", `// ${file}`);
    for (const [name, def] of Object.entries(schema.$defs ?? {})) {
      out.push("", declaration(file, name, def));
      if (def.type === "object" && def.properties) out.push(...constants(file, name, def));
    }
    out.push("", declaration(file, schema.title, schema));
    out.push(...constants(file, schema.title, schema));
  }
  if (versions.size !== 1) throw new Error(`${versionDir}: the schemas disagree on schema_version`);

  // The shapes go last, each after the shapes it nests, since a schema may nest another file's object.
  out.push("", "// Each object's shape: its field list, its required fields, its strings' caps and its nested objects' shapes.");
  /** @type {Set<string>} */
  const emitted = new Set();
  /** @type {Set<string>} */
  const visiting = new Set();
  /** @param {string} name */
  function emitShape(name) {
    if (emitted.has(name)) return;
    if (visiting.has(name)) throw new Error(`${name} nests itself`);
    visiting.add(name);
    const shape = /** @type {{ prefix: string, capped: boolean, nested: [string, string][] }} */ (shapes.get(name));
    for (const [, target] of shape.nested) emitShape(target);
    const nested = shape.nested.map(([key, target]) => `${key}: ${screaming(target)}_SHAPE`).join(", ");
    out.push(
      "",
      `export const ${shape.prefix}_SHAPE = { fields: ${shape.prefix}_FIELDS, required: ${shape.prefix}_REQUIRED, maxLength: ${shape.capped ? `${shape.prefix}_MAX_LENGTH` : "{}"}, nested: {${nested ? ` ${nested} ` : ""}} } as const;`,
    );
    visiting.delete(name);
    emitted.add(name);
  }
  for (const name of shapes.keys()) emitShape(name);

  out.push("", `export const SCHEMA_VERSION = ${JSON.stringify([...versions][0])};`, "");
  return out.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const versions = schemaVersions();
  const latest = versions[versions.length - 1];
  if (latest === undefined) throw new Error(`no schema/v<N> directory in ${SCHEMA_ROOT}`);
  mkdirSync(dirname(GENERATED_FILE), { recursive: true });
  writeFileSync(GENERATED_FILE, generate(join(SCHEMA_ROOT, `v${latest}`)));
  console.log(`${GENERATED_FILE} from schema/v${latest}`);
}
