// Generates src/wire/generated.ts from the newest wire JSON Schema in schema/v<N>/: a TypeScript
// type for each schema and each of its $defs, and, for each object with properties (a schema's
// top-level object or an object in $defs), its field list, its required fields, its fields' JSON
// types, const or enum values, minimums and patterns, its strings' length caps, its arrays' item caps and a shape that
// ties in its nested objects' shapes, its arrays' item shapes and its maps' rules, which the payload
// builder uses. A map is an object in $defs with no properties, whose additionalProperties name the
// schema of its values. A branch of a oneOf of objects types the properties its siblings have and
// it lacks as never, and an array with minItems of 1 or more is a non-empty tuple, so that what the
// schema refuses doesn't compile either. The schema is the source of truth; a test fails when the committed file
// differs from what this generates.
//
// It covers the subset of JSON Schema the wire uses (object, map, array, string, number, integer,
// boolean, const, enum, oneOf, $ref) and throws on anything else, rather than generate a looser type
// or looser rules: an object's or a map's keywords, a $ref's siblings and the rules inside a oneOf
// of scalars go through allow-lists too. An object with a field whose shape the builder couldn't
// check (a oneOf of objects, an array of scalars, an inline object) gets no shape at all, rather
// than a partial one. Every schema's $id must be its own path in schema/v<N>/, and every
// schema_version const N.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
// The keywords of an object with properties, each of which the generator keeps.
const OBJECT_KEYWORDS = new Set([
  "$schema", "$id", "$defs", "title", "description", "type", "properties", "required", "additionalProperties",
]);
// The keywords of a map, each of which the generator keeps.
const MAP_KEYWORDS = new Set(["title", "description", "type", "maxProperties", "propertyNames", "additionalProperties"]);
// The keywords a $ref may have beside it: any other would constrain the value, and following the
// $ref would lose it.
const REF_SIBLINGS = new Set(["$ref", "title", "description"]);
// The keywords a scalar oneOf branch may have: a rule inside a branch has no place in a shape.
const SCALAR_BRANCH_KEYWORDS = new Set(["type", "title", "description"]);
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
  const dirName = basename(versionDir);
  const versionMatch = /^v([1-9][0-9]*)$/.exec(dirName);
  if (!versionMatch) throw new Error(`${versionDir}: a schema directory is named v<N>`);
  const version = Number(versionMatch[1]);
  const files = readdirSync(versionDir).filter((name) => name.endsWith(".json")).sort();
  /** @type {Map<string, any>} */
  const schemas = new Map(files.map((name) => [name, JSON.parse(readFileSync(join(versionDir, name), "utf8"))]));
  for (const [file, schema] of schemas) {
    // A $id left from the version a schema was copied from would have validators resolve its
    // relative $refs against that version.
    if (typeof schema.$id !== "string" || !schema.$id.endsWith(`/${dirName}/${file}`)) {
      throw new Error(`${file}: its $id must end in /${dirName}/${file}, not ${JSON.stringify(schema.$id)}`);
    }
  }

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
    const siblings = Object.keys(node).filter((key) => !REF_SIBLINGS.has(key));
    if (siblings.length > 0) throw new Error(`${file}: $ref ${node.$ref} has ${siblings.join(", ")} beside it, which following it would lose`);
    const target = resolveRef(file, node.$ref);
    return follow(target.file, target.schema);
  }

  /**
   * The last schema a chain of $refs names, with its name, which its shape or rules go by; undefined
   * when the node is no $ref.
   * @param {string} file
   * @param {any} node
   * @returns {{ name: string, schema: any, file: string } | undefined}
   */
  function lastNamed(file, node) {
    if (!node.$ref) return undefined;
    follow(file, node);
    const target = resolveRef(file, node.$ref);
    return lastNamed(target.file, target.schema) ?? target;
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
    if (node.$ref) {
      follow(file, node);
      return resolveRef(file, node.$ref).name;
    }
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
        const list = item.includes(" | ") ? `(${item})[]` : `${item}[]`;
        // An array the schema needs an item in is a non-empty tuple, so an empty one doesn't compile.
        return typeof node.minItems === "number" && node.minItems >= 1 ? `[${item}, ...${list}]` : list;
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
   * @param {string} name
   * @param {any} node
   * @param {Set<string>} allowed
   */
  function checkKeywords(file, name, node, allowed) {
    for (const key of Object.keys(node)) {
      if (!allowed.has(key)) throw new Error(`${file}: ${name} has keyword ${key}, which the generator doesn't keep`);
    }
  }

  /**
   * @param {string} file
   * @param {string} name
   * @param {any} node
   */
  function declaration(file, name, node) {
    const doc = node.description ? `/** ${node.description} */\n` : "";
    if (node.type === "object" && node.properties) {
      checkKeywords(file, name, node, OBJECT_KEYWORDS);
      if (node.additionalProperties !== false) throw new Error(`${file}: ${name} must set additionalProperties: false`);
      const required = new Set(node.required ?? []);
      const fields = Object.entries(node.properties).map(([key, prop]) => {
        const fieldDoc = /** @type {any} */ (prop).description ? `  /** ${/** @type {any} */ (prop).description} */\n` : "";
        return `${fieldDoc}  ${key}${required.has(key) ? "" : "?"}: ${typeOf(file, prop)};`;
      });
      // The properties a sibling oneOf branch has and this one lacks, as never: TypeScript's excess
      // property check on a union accepts a key any branch declares, so without them a value of
      // this branch could carry another's field (a PingBatch its seq) and still compile.
      const foreign = [...(exclusive.get(name) ?? [])].filter((key) => !(key in node.properties));
      fields.push(...foreign.map((key) => `  ${key}?: never;`));
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
    checkKeywords(file, name, node, MAP_KEYWORDS);
    if (node.propertyNames) checkKeywords(file, `${name}'s propertyNames`, node.propertyNames, new Set([...SCALAR_BRANCH_KEYWORDS, "pattern"]));
    const values = follow(file, node.additionalProperties);
    /** @type {any[]} */
    const branches = (values.schema.oneOf ?? [values.schema]).map((/** @type {any} */ branch) => follow(values.file, branch).schema);
    /** @type {string[]} */
    const types = [];
    /** @type {number | undefined} */
    let maxLength;
    for (const branch of branches) {
      const extra = Object.keys(branch).filter((key) => !["type", "maxLength", "description"].includes(key));
      if (!SCALARS.has(branch.type) || extra.length > 0) {
        throw new Error(`${file}: ${name}'s values must be strings, numbers or booleans with at most a maxLength`);
      }
      if (branch.type === "string" && types.includes("string")) {
        throw new Error(`${file}: ${name}'s values have more than one string branch, and the builder keeps one maxLength`);
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
   * objects, arrays of objects and maps, each with the name of the object or map they hold; or, in
   * unshaped, a field the builder could check by no shape, which leaves the object without one.
   * @typedef {{ prefix: string, has: Set<string>, nested: [string, string][], items: [string, string][], maps: [string, string][], unshaped: string | undefined }} ShapeInfo
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
    // Each field with its JSON type, and its schema with its $refs followed and the file it is in.
    const props = keys.map((key) => ({ key, type: jsonType(file, `${name}.${key}`, node.properties[key]), ...follow(file, node.properties[key]) }));
    for (const { key, type, file: at, schema: prop } of props) {
      // A scalar oneOf's branches are only told apart by type: a rule in one of them would be lost.
      if (type !== "object" && prop.oneOf) {
        for (const branch of prop.oneOf) {
          checkKeywords(file, `a oneOf branch of ${name}.${key}`, follow(at, branch).schema, SCALAR_BRANCH_KEYWORDS);
        }
      }
      if (key === "schema_version") {
        if (prop.const !== version) {
          throw new Error(`${file}: ${name}.schema_version is const ${JSON.stringify(prop.const)}, not ${version} as its directory ${dirName}`);
        }
        versionDeclared = true;
      }
    }
    const types = props.map(({ key, type }) => `${key}: ${JSON.stringify(type)}`);
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
      const entries = props
        .map(({ key, schema }) => [key, rule(schema)])
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? `[${value.map((item) => JSON.stringify(item)).join(", ")}]` : JSON.stringify(value)}`);
      if (entries.length === 0) return;
      has.add(suffix);
      lines.push("", `export const ${prefix}_${suffix} = { ${entries.join(", ")} } as const;`);
    }
    ruleConstant("VALUES", (prop) => ("const" in prop ? [prop.const] : prop.enum));
    ruleConstant("MINIMUM", (prop) => (typeof prop.minimum === "number" ? prop.minimum : undefined));
    ruleConstant("PATTERN", (prop) => (typeof prop.pattern === "string" ? prop.pattern : undefined));
    ruleConstant("MAX_LENGTH", (prop) => (typeof prop.maxLength === "number" ? prop.maxLength : undefined));
    ruleConstant("MAX_ITEMS", (prop) => (typeof prop.maxItems === "number" ? prop.maxItems : undefined));
    /** @type {[string, string][]} */
    const nested = [];
    /** @type {[string, string][]} */
    const items = [];
    /** @type {[string, string][]} */
    const maps = [];
    /** @type {string | undefined} */
    let unshaped;
    for (const { key, type, file: at, schema: prop } of props) {
      if (type !== "object" && type !== "array") continue;
      // The object, map or array items it holds, named, so that its shape or rules can be tied in.
      const named = prop.type === "array" ? lastNamed(at, prop.items) : lastNamed(file, node.properties[key]);
      if (named !== undefined && named.schema.type === "object" && named.schema.properties) {
        (prop.type === "array" ? items : nested).push([key, named.name]);
      } else if (named !== undefined && prop.type !== "array" && isMap(named.schema)) {
        maps.push([key, named.name]);
      } else {
        unshaped ??= key;
      }
    }
    if (shapes.has(name)) throw new Error(`${file}: ${name} is named twice`);
    shapes.set(name, { prefix, has, nested, items, maps, unshaped });
    return lines;
  }

  /**
   * A oneOf's branches as the named objects they are, a branch that is itself a oneOf giving its
   * own; undefined when a branch is anything but a named object with properties, such as a string.
   * @param {string} file
   * @param {any[]} branches
   * @returns {{ name: string, schema: any }[] | undefined}
   */
  function objectBranches(file, branches) {
    /** @type {{ name: string, schema: any }[]} */
    const objects = [];
    for (const branch of branches) {
      if (!branch.$ref) return undefined;
      const target = resolveRef(file, branch.$ref);
      const inner = target.schema.oneOf ? objectBranches(target.file, target.schema.oneOf) : undefined;
      if (inner) objects.push(...inner);
      else if (target.schema.type === "object" && target.schema.properties) objects.push(target);
      else return undefined;
    }
    return objects;
  }

  /**
   * For each object that is a branch of a oneOf of objects, anywhere in the schemas, the properties
   * its sibling branches have, which declaration types as never where it lacks them.
   * @type {Map<string, Set<string>>}
   */
  const exclusive = new Map();
  /**
   * @param {string} file
   * @param {any} node
   */
  function collectExclusive(file, node) {
    if (node === null || typeof node !== "object") return;
    const branches = node.oneOf ? objectBranches(file, node.oneOf) : undefined;
    for (const branch of branches ?? []) {
      const keys = exclusive.get(branch.name) ?? new Set();
      for (const sibling of branches ?? []) for (const key of Object.keys(sibling.schema.properties)) keys.add(key);
      exclusive.set(branch.name, keys);
    }
    for (const child of [
      ...Object.values(node.properties ?? {}),
      ...Object.values(node.$defs ?? {}),
      ...(node.oneOf ?? []),
      node.items,
      node.additionalProperties,
    ]) {
      collectExclusive(file, child);
    }
  }
  for (const [file, schema] of schemas) collectExclusive(file, schema);

  // Whether an object declares schema_version; constants() checks that each one's is the directory's.
  // An envelope with no schema_version of its own (batch.json, whose items carry theirs) has its
  // directory's version.
  let versionDeclared = false;
  const out = [
    `// Generated by scripts/gen-wire.mjs from schema/${dirName}/. Do not edit: change the`,
    "// schema and run `pnpm gen:wire`.",
  ];
  for (const [file, schema] of schemas) {
    out.push("", `// ${file}`);
    for (const [name, def] of Object.entries(schema.$defs ?? {})) {
      out.push("", declaration(file, name, def));
      if (def.type === "object" && def.properties) out.push(...constants(file, name, def));
      if (isMap(def)) out.push(...mapConstant(file, name, def));
    }
    out.push("", declaration(file, schema.title, schema));
    if (schema.type === "object" && schema.properties) out.push(...constants(file, schema.title, schema));
  }
  if (!versionDeclared) throw new Error(`${versionDir}: no schema declares schema_version`);

  // The shapes go last, each after the shapes it nests, since a schema may nest another file's object.
  out.push(
    "",
    "// Each object's shape: its field list, its required fields, its fields' types, const or enum values, minimums",
    "// and patterns, its strings' and arrays' caps, its nested objects' shapes, its arrays' item shapes and its maps' rules.",
    "// An object with a field no shape can check (a oneOf of objects, an array of scalars) has none.",
  );
  /** @type {Map<string, boolean>} whether each object visited has a shape */
  const emitted = new Map();
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
  /**
   * @param {string} name
   * @returns {boolean} whether the object has a shape: none when a field of it, or of an object it
   * nests, has none the builder could check
   */
  function emitShape(name) {
    const done = emitted.get(name);
    if (done !== undefined) return done;
    if (visiting.has(name)) throw new Error(`${name} nests itself`);
    visiting.add(name);
    const shape = /** @type {ShapeInfo} */ (shapes.get(name));
    let complete = shape.unshaped === undefined;
    for (const [, target] of [...shape.nested, ...shape.items]) complete = emitShape(target) && complete;
    if (complete) {
      const { prefix, has } = shape;
      /** @param {string} suffix */
      const rule = (suffix) => (has.has(suffix) ? `${prefix}_${suffix}` : "{}");
      out.push(
        "",
        `export const ${prefix}_SHAPE = { fields: ${prefix}_FIELDS, required: ${prefix}_REQUIRED, types: ${prefix}_TYPES, values: ${rule("VALUES")}, minimum: ${rule("MINIMUM")}, pattern: ${rule("PATTERN")}, maxLength: ${rule("MAX_LENGTH")}, maxItems: ${rule("MAX_ITEMS")}, nested: ${record(shape.nested, "_SHAPE")}, items: ${record(shape.items, "_SHAPE")}, maps: ${record(shape.maps, "_MAP")} } as const;`,
      );
    }
    visiting.delete(name);
    emitted.set(name, complete);
    return complete;
  }
  for (const name of shapes.keys()) emitShape(name);

  out.push("", `export const SCHEMA_VERSION = ${version};`, "");
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
