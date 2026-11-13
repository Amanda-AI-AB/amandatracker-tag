// Generates src/wire/generated.ts from the newest wire JSON Schema in schema/v<N>/: a TypeScript
// type for each schema and each of its $defs, and, for each object with properties (a schema's
// top-level object or an object in $defs), its field list, its required fields, its fields' JSON
// types, const or enum values, minimums and patterns, its strings' length caps, its arrays' item caps and a shape that
// ties in its nested objects' shapes, its arrays' item shapes and its maps' rules, which the payload
// builder uses. A map is an object in $defs with no properties, whose additionalProperties name the
// schema of its values. The schema is the source of truth; a test fails when the committed file
// differs from what this generates.
//
// It covers the subset of JSON Schema the wire uses (object, map, array, string, number, integer,
// boolean, const, enum, oneOf, $ref) and throws on anything else, rather than generate a looser type.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "../..");
export const SCHEMA_ROOT = join(root, "schema");
export const GENERATED_FILE = join(root, "src/wire/generated.ts");

// Keywords that only document or constrain values, and change no TypeScript type.
const ANNOTATIONS = new Set([
  "$schema", "$id", "$defs", "title", "description", "minLength", "maxLength", "pattern", "minimum",
  "minItems", "maxItems", "maxProperties",
]);
// Keywords the generator turns into types.
const TYPED = new Set([
  "type", "const", "enum", "oneOf", "$ref", "properties", "required", "additionalProperties", "items",
  "propertyNames",
]);
// The JSON types a map's values may have.
const SCALARS = new Set(["string", "number", "integer", "boolean"]);
// The JSON types an object's property may have.
const JSON_TYPES = new Set([...SCALARS, "object", "array"]);

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
   * @returns {{ name: string, schema: any, file: string }}
   */
  function resolveRef(file, ref) {
    const [target, pointer = ""] = ref.split("#");
    const targetFile = target || file;
    const schema = schemas.get(targetFile);
    if (!schema) throw new Error(`${file}: $ref ${ref} names no schema in ${versionDir}`);
    if (pointer === "") return { name: schema.title, schema, file: targetFile };
    const name = /^\/\$defs\/([A-Za-z0-9]+)$/.exec(pointer)?.[1];
    const def = name === undefined ? undefined : schema.$defs?.[name];
    if (name === undefined || !def) throw new Error(`${file}: $ref ${ref} resolves to nothing`);
    return { name, schema: def, file: targetFile };
  }

  /**
   * A node with its $refs followed, and the file it is in, which its own $refs are relative to.
   * @param {string} file
   * @param {any} node
   * @returns {{ file: string, schema: any }}
   */
  function follow(file, node) {
    if (!node.$ref) return { file, schema: node };
    const target = resolveRef(file, node.$ref);
    return follow(target.file, target.schema);
  }

  /** @param {unknown} value */
  function valueType(value) {
    if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
    if (typeof value === "string" || typeof value === "boolean") return typeof value;
    throw new Error(`a const or enum value must be a string, number or boolean, not ${JSON.stringify(value)}`);
  }

  /**
   * A property's JSON type, which the payload builder checks its value against: a const's or an
   * enum's by its values, and a oneOf's when its branches agree. Throws when it has no single type,
   * rather than leave the value unchecked.
   * @param {string} file
   * @param {string} name
   * @param {any} node
   * @returns {string}
   */
  function jsonType(file, name, node) {
    const { file: at, schema } = follow(file, node);
    const values = "const" in schema ? [schema.const] : schema.enum;
    /** @type {string[]} */
    const types = values
      ? values.map(valueType)
      : schema.oneOf
        ? schema.oneOf.map((/** @type {any} */ branch) => jsonType(at, name, branch))
        : [schema.type];
    const [type, ...others] = new Set(types);
    if (type === undefined || others.length > 0 || !JSON_TYPES.has(type)) throw new Error(`${file}: ${name} has no single JSON type`);
    return type;
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
      case "array": {
        if (!node.items) throw new Error(`${file}: an array needs items`);
        const item = typeOf(file, node.items);
        return item.includes(" | ") ? `(${item})[]` : `${item}[]`;
      }
      case "object": {
        if (node.properties) throw new Error(`${file}: name a nested object in $defs`);
        if (node.propertyNames && typeOf(file, node.propertyNames) !== "string") {
          throw new Error(`${file}: propertyNames must be a string schema`);
        }
        const values = node.additionalProperties;
        if (values === undefined || values === true) return "Record<string, unknown>";
        if (typeof values !== "object") throw new Error(`${file}: an object with no properties must allow some`);
        return `Record<string, ${typeOf(file, values)}>`;
      }
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

  /** @param {any} node */
  function isMap(node) {
    return node.type === "object" && !node.properties && typeof node.additionalProperties === "object";
  }

  /**
   * A map's rules, for the payload builder: its key cap and pattern, its values' JSON types and
   * their strings' length cap. Throws on a value constraint the builder couldn't keep.
   * @param {string} file
   * @param {string} name
   * @param {any} node
   * @returns {string[]}
   */
  function mapConstant(file, name, node) {
    const values = deref(file, node.additionalProperties);
    /** @type {any[]} */
    const branches = (values.oneOf ?? [values]).map((/** @type {any} */ branch) => deref(file, branch));
    /** @type {string[]} */
    const types = [];
    /** @type {number | undefined} */
    let maxLength;
    for (const branch of branches) {
      const extra = Object.keys(branch).filter((key) => !["type", "maxLength", "description"].includes(key));
      if (!SCALARS.has(branch.type) || extra.length > 0) {
        throw new Error(`${file}: ${name}'s values must be strings, numbers or booleans with at most a maxLength`);
      }
      types.push(branch.type);
      if (typeof branch.maxLength === "number") maxLength = branch.maxLength;
    }
    const rules = [
      typeof node.maxProperties === "number" ? `maxProperties: ${node.maxProperties}` : undefined,
      typeof node.propertyNames?.pattern === "string" ? `keyPattern: ${JSON.stringify(node.propertyNames.pattern)}` : undefined,
      `values: [${types.map((type) => JSON.stringify(type)).join(", ")}]`,
      maxLength === undefined ? undefined : `maxLength: ${maxLength}`,
    ].filter((rule) => rule !== undefined);
    return ["", `export const ${screaming(name)}_MAP = { ${rules.join(", ")} } as const;`];
  }

  /**
   * An object's shape, for the payload builder: its prefix, which of its optional rule constants
   * it has (VALUES, MINIMUM, PATTERN, MAX_LENGTH, MAX_ITEMS), and the properties that are nested
   * objects, arrays of objects and maps, each with the name of the object or map they hold.
   * @typedef {{ prefix: string, has: Set<string>, nested: [string, string][], items: [string, string][], maps: [string, string][] }} ShapeInfo
   * @type {Map<string, ShapeInfo>}
   */
  const shapes = new Map();

  /**
   * The field list, the fields' JSON types, their const or enum values, their numbers' minimums,
   * their strings' patterns and length caps and their arrays' item caps of an object with
   * properties, and its shape.
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
    const types = keys.map((key) => `${key}: ${JSON.stringify(jsonType(file, `${name}.${key}`, node.properties[key]))}`);
    const lines = [
      "",
      `export const ${prefix}_FIELDS = [${keys.map((key) => JSON.stringify(key)).join(", ")}] as const;`,
      "",
      `export const ${prefix}_REQUIRED = [${required.map((key) => JSON.stringify(key)).join(", ")}] as const;`,
      "",
      `export const ${prefix}_TYPES = { ${types.join(", ")} } as const;`,
    ];
    /** @type {Set<string>} */
    const has = new Set();
    /**
     * @param {string} suffix
     * @param {(prop: any) => unknown} rule a property's rule, or undefined when it has none
     */
    function ruleConstant(suffix, rule) {
      const entries = keys
        .map((key) => [key, rule(follow(file, node.properties[key]).schema)])
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? `[${value.map((item) => JSON.stringify(item)).join(", ")}]` : JSON.stringify(value)}`);
      if (entries.length === 0) return;
      has.add(suffix);
      lines.push("", `export const ${prefix}_${suffix} = { ${entries.join(", ")} } as const;`);
    }
    ruleConstant("VALUES", (prop) => ("const" in prop ? [prop.const] : prop.enum));
    ruleConstant("MINIMUM", (prop) => (typeof prop.minimum === "number" ? prop.minimum : undefined));
    ruleConstant("PATTERN", (prop) => (typeof prop.pattern === "string" ? prop.pattern : undefined));
    const caps = keys
      .map((key) => [key, deref(file, node.properties[key])])
      .filter(([, prop]) => prop.type === "string" && typeof prop.maxLength === "number")
      .map(([key, prop]) => `${key}: ${prop.maxLength}`);
    if (caps.length > 0) {
      has.add("MAX_LENGTH");
      lines.push("", `export const ${prefix}_MAX_LENGTH = { ${caps.join(", ")} } as const;`);
    }
    const itemCaps = keys
      .map((key) => [key, deref(file, node.properties[key])])
      .filter(([, prop]) => prop.type === "array" && typeof prop.maxItems === "number")
      .map(([key, prop]) => `${key}: ${prop.maxItems}`);
    if (itemCaps.length > 0) {
      has.add("MAX_ITEMS");
      lines.push("", `export const ${prefix}_MAX_ITEMS = { ${itemCaps.join(", ")} } as const;`);
    }
    /** @type {[string, string][]} */
    const nested = [];
    /** @type {[string, string][]} */
    const items = [];
    /** @type {[string, string][]} */
    const maps = [];
    for (const key of keys) {
      const prop = node.properties[key];
      const ref = prop.$ref ?? (prop.type === "array" ? prop.items?.$ref : undefined);
      if (!ref) continue;
      const target = resolveRef(file, ref);
      const isObject = target.schema.type === "object" && target.schema.properties;
      if (prop.type === "array") {
        if (isObject) items.push([key, target.name]);
      } else if (isObject) {
        nested.push([key, target.name]);
      } else if (isMap(target.schema)) {
        maps.push([key, target.name]);
      }
    }
    if (shapes.has(name)) throw new Error(`${file}: ${name} is named twice`);
    shapes.set(name, { prefix, has, nested, items, maps });
    return lines;
  }

  const out = [
    `// Generated by scripts/gen-wire.mjs from schema/${versionDir.split(/[\\/]/).pop()}/. Do not edit: change the`,
    "// schema and run `pnpm gen:wire`.",
  ];
  /** @type {Set<unknown>} */
  const versions = new Set();
  for (const [file, schema] of schemas) {
    // An envelope with no schema_version of its own (batch.json, whose items carry theirs) has its
    // directory's version.
    const version = schema.properties?.schema_version?.const;
    if (version !== undefined) versions.add(version);
    out.push("", `// ${file}`);
    for (const [name, def] of Object.entries(schema.$defs ?? {})) {
      out.push("", declaration(file, name, def));
      if (def.type === "object" && def.properties) out.push(...constants(file, name, def));
      if (isMap(def)) out.push(...mapConstant(file, name, def));
    }
    out.push("", declaration(file, schema.title, schema));
    if (schema.type === "object" && schema.properties) out.push(...constants(file, schema.title, schema));
  }
  if (versions.size === 0) throw new Error(`${versionDir}: no schema declares schema_version`);
  if (versions.size !== 1) throw new Error(`${versionDir}: the schemas disagree on schema_version`);

  // The shapes go last, each after the shapes it nests, since a schema may nest another file's object.
  out.push(
    "",
    "// Each object's shape: its field list, its required fields, its fields' types, const or enum values, minimums",
    "// and patterns, its strings' and arrays' caps, its nested objects' shapes, its arrays' item shapes and its maps' rules.",
  );
  /** @type {Set<string>} */
  const emitted = new Set();
  /** @type {Set<string>} */
  const visiting = new Set();
  /**
   * @param {[string, string][]} pairs
   * @param {string} suffix
   */
  function record(pairs, suffix) {
    const body = pairs.map(([key, target]) => `${key}: ${screaming(target)}${suffix}`).join(", ");
    return `{${body ? ` ${body} ` : ""}}`;
  }
  /** @param {string} name */
  function emitShape(name) {
    if (emitted.has(name)) return;
    if (visiting.has(name)) throw new Error(`${name} nests itself`);
    visiting.add(name);
    const shape = /** @type {ShapeInfo} */ (shapes.get(name));
    for (const [, target] of [...shape.nested, ...shape.items]) emitShape(target);
    const { prefix, has } = shape;
    /** @param {string} suffix */
    const rule = (suffix) => (has.has(suffix) ? `${prefix}_${suffix}` : "{}");
    out.push(
      "",
      `export const ${prefix}_SHAPE = { fields: ${prefix}_FIELDS, required: ${prefix}_REQUIRED, types: ${prefix}_TYPES, values: ${rule("VALUES")}, minimum: ${rule("MINIMUM")}, pattern: ${rule("PATTERN")}, maxLength: ${rule("MAX_LENGTH")}, maxItems: ${rule("MAX_ITEMS")}, nested: ${record(shape.nested, "_SHAPE")}, items: ${record(shape.items, "_SHAPE")}, maps: ${record(shape.maps, "_MAP")} } as const;`,
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
