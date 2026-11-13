import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generate, GENERATED_FILE, schemaVersions, SCHEMA_ROOT } from "../scripts/gen-wire.mjs";

describe("gen-wire", () => {
  let root: string;
  let dir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gen-wire-"));
    useVersion(1);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Writes the schemas after it to schema/v<version>/. */
  function useVersion(version: number): void {
    dir = join(root, `v${version}`);
    mkdirSync(dir, { recursive: true });
  }

  /** Writes a schema, with the $id of its path when it names none. */
  function schema(file: string, body: Record<string, unknown>): void {
    const $id = `https://example.test/schema/${dir.split("/").pop()}/${file}`;
    writeFileSync(join(dir, file), JSON.stringify({ $id, ...body }));
  }

  it("src/wire/generated.ts is what the newest schema generates (run `pnpm gen:wire`)", () => {
    const latest = schemaVersions().at(-1);
    expect(latest).toBe(1);
    expect(readFileSync(GENERATED_FILE, "utf8")).toBe(generate(join(SCHEMA_ROOT, `v${latest}`)));
  });

  it("finds the schema versions in order", () => {
    for (const name of ["v10", "v2", "v1", "draft", "v0"]) mkdirSync(join(dir, name));
    expect(schemaVersions(dir)).toEqual([1, 2, 10]);
  });

  it("generates types, field lists and length caps", () => {
    useVersion(3);
    schema("a.json", {
      title: "Thing",
      type: "object",
      additionalProperties: false,
      required: ["schema_version", "name"],
      properties: {
        schema_version: { const: 3 },
        name: { type: "string", maxLength: 10 },
        kind: { $ref: "#/$defs/Kind" },
      },
      $defs: { Kind: { enum: ["a", "b"] } },
    });

    const out = generate(dir);
    expect(out).toContain('export type Kind = "a" | "b";');
    expect(out).toContain("export interface Thing {\n  schema_version: 3;\n  name: string;\n  kind?: Kind;\n}");
    expect(out).toContain('export const THING_FIELDS = ["schema_version", "name", "kind"] as const;');
    expect(out).toContain('export const THING_REQUIRED = ["schema_version", "name"] as const;');
    expect(out).toContain("export const THING_MAX_LENGTH = { name: 10 } as const;");
    expect(out).toContain('export const THING_TYPES = { schema_version: "integer", name: "string", kind: "string" } as const;');
    expect(out).toContain('export const THING_VALUES = { schema_version: [3], kind: ["a", "b"] } as const;');
    expect(out).toContain(
      "export const THING_SHAPE = { fields: THING_FIELDS, required: THING_REQUIRED, types: THING_TYPES, values: THING_VALUES, minimum: {}, pattern: {}, maxLength: THING_MAX_LENGTH, maxItems: {}, nested: {}, items: {}, maps: {} } as const;",
    );
    expect(out).toContain("export const SCHEMA_VERSION = 3;");
  });

  it("generates field lists, caps and shapes for nested objects, each shape after those it nests", () => {
    schema("a.json", {
      title: "Thing",
      type: "object",
      additionalProperties: false,
      properties: { schema_version: { const: 1 }, part: { $ref: "b.json#/$defs/Part" } },
    });
    schema("b.json", {
      title: "Other",
      type: "object",
      additionalProperties: false,
      properties: { schema_version: { const: 1 } },
      $defs: {
        Part: {
          type: "object",
          additionalProperties: false,
          properties: { label: { type: "string", maxLength: 8 }, flag: { type: "boolean" } },
        },
      },
    });

    const out = generate(dir);
    expect(out).toContain('export const PART_FIELDS = ["label", "flag"] as const;');
    expect(out).toContain("export const PART_MAX_LENGTH = { label: 8 } as const;");
    expect(out).toContain("export const PART_REQUIRED = [] as const;");
    expect(out).toContain(
      "export const PART_SHAPE = { fields: PART_FIELDS, required: PART_REQUIRED, types: PART_TYPES, values: {}, minimum: {}, pattern: {}, maxLength: PART_MAX_LENGTH, maxItems: {}, nested: {}, items: {}, maps: {} } as const;",
    );
    expect(out).toContain(
      "export const THING_SHAPE = { fields: THING_FIELDS, required: THING_REQUIRED, types: THING_TYPES, values: THING_VALUES, minimum: {}, pattern: {}, maxLength: {}, maxItems: {}, nested: { part: PART_SHAPE }, items: {}, maps: {} } as const;",
    );
    expect(out).toContain('export const THING_TYPES = { schema_version: "integer", part: "object" } as const;');
    expect(out.indexOf("PART_SHAPE = ")).toBeLessThan(out.indexOf("THING_SHAPE = "));
  });

  it("generates arrays of objects with their item shapes, each after the shape of its items", () => {
    schema("a.json", {
      title: "Order",
      type: "object",
      additionalProperties: false,
      properties: {
        schema_version: { const: 1 },
        lines: { type: "array", maxItems: 5, items: { $ref: "#/$defs/Line" } },
      },
      $defs: {
        Line: { type: "object", additionalProperties: false, required: ["sku"], properties: { sku: { type: "string", maxLength: 9 } } },
      },
    });

    const out = generate(dir);
    expect(out).toContain("export interface Order {\n  schema_version?: 1;\n  lines?: Line[];\n}");
    expect(out).toContain(
      "export const ORDER_SHAPE = { fields: ORDER_FIELDS, required: ORDER_REQUIRED, types: ORDER_TYPES, values: ORDER_VALUES, minimum: {}, pattern: {}, maxLength: {}, maxItems: ORDER_MAX_ITEMS, nested: {}, items: { lines: LINE_SHAPE }, maps: {} } as const;",
    );
    expect(out.indexOf("LINE_SHAPE = ")).toBeLessThan(out.indexOf("ORDER_SHAPE = "));
  });

  it("generates the fields' minimums and patterns, following $refs into other files", () => {
    schema("a.json", {
      title: "Thing",
      type: "object",
      additionalProperties: false,
      properties: {
        schema_version: { const: 1 },
        code: { type: "string", pattern: "^[A-Z]{3}$" },
        count: { type: "integer", minimum: 1 },
        amount: { type: "number", minimum: 0 },
        id: { $ref: "b.json#/$defs/Id" },
        either: { oneOf: [{ $ref: "b.json" }, { $ref: "b.json#/$defs/Pair" }] },
      },
    });
    schema("b.json", {
      title: "Other",
      oneOf: [{ $ref: "#/$defs/Pair" }],
      $defs: {
        Id: { $ref: "#/$defs/Hex" },
        Hex: { type: "string", pattern: "^[0-9a-f]{2,8}$" },
        Pair: { type: "object", additionalProperties: false, properties: { n: { type: "number" } } },
      },
    });

    const out = generate(dir);
    expect(out).toContain(
      'export const THING_TYPES = { schema_version: "integer", code: "string", count: "integer", amount: "number", id: "string", either: "object" } as const;',
    );
    expect(out).toContain("export const THING_MINIMUM = { count: 1, amount: 0 } as const;");
    expect(out).toContain('export const THING_PATTERN = { code: "^[A-Z]{3}$", id: "^[0-9a-f]{2,8}$" } as const;');
    // either, a oneOf of objects, has no shape the builder could check it by: neither has Thing.
    expect(out).not.toContain("THING_SHAPE");
  });

  it("refuses a field with no single JSON type, rather than leave its value unchecked", () => {
    schema("a.json", {
      title: "Thing",
      type: "object",
      additionalProperties: false,
      properties: { schema_version: { const: 1 }, n: { oneOf: [{ type: "string" }, { type: "number" }] } },
    });
    expect(() => generate(dir)).toThrow("Thing.n has no single JSON type");
  });

  it("generates a map's type and rules, and ties it into the shapes that hold it", () => {
    schema("a.json", {
      title: "Thing",
      type: "object",
      additionalProperties: false,
      properties: { schema_version: { const: 1 }, bag: { $ref: "#/$defs/Bag" } },
      $defs: {
        Bag: {
          type: "object",
          maxProperties: 3,
          propertyNames: { type: "string", pattern: "^[a-z]" },
          additionalProperties: { $ref: "#/$defs/Value" },
        },
        Value: { oneOf: [{ type: "string", maxLength: 7 }, { type: "integer" }, { type: "boolean" }] },
        Plain: { type: "object", additionalProperties: { type: "number" } },
      },
    });

    const out = generate(dir);
    expect(out).toContain("export type Bag = Record<string, Value>;");
    expect(out).toContain("export type Value = string | number | boolean;");
    expect(out).toContain(
      'export const BAG_MAP = { maxProperties: 3, keyPattern: "^[a-z]", values: ["string", "integer", "boolean"], maxLength: 7 } as const;',
    );
    expect(out).toContain('export const PLAIN_MAP = { values: ["number"] } as const;');
    expect(out).toContain("maps: { bag: BAG_MAP } } as const;");
  });

  it("refuses a map whose values the builder couldn't keep to the schema", () => {
    schema("a.json", {
      title: "Thing",
      type: "object",
      additionalProperties: false,
      properties: { schema_version: { const: 1 } },
      $defs: { Bag: { type: "object", additionalProperties: { type: "string", pattern: "^x" } } },
    });
    expect(() => generate(dir)).toThrow("Bag's values must be strings, numbers or booleans");
  });

  it("refuses a map whose values have more than one string branch", () => {
    schema("a.json", {
      title: "Thing",
      type: "object",
      additionalProperties: false,
      properties: { schema_version: { const: 1 } },
      $defs: {
        Bag: {
          type: "object",
          additionalProperties: { oneOf: [{ type: "string", maxLength: 200 }, { type: "string", maxLength: 64 }] },
        },
      },
    });
    expect(() => generate(dir)).toThrow("Bag's values have more than one string branch");
  });

  it("refuses propertyNames that aren't a string schema", () => {
    schema("a.json", {
      title: "Thing",
      type: "object",
      additionalProperties: false,
      properties: { schema_version: { const: 1 } },
      $defs: { Bag: { type: "object", propertyNames: { enum: [1] }, additionalProperties: { type: "string" } } },
    });
    expect(() => generate(dir)).toThrow("propertyNames must be a string schema");
  });

  it("generates arrays, their item caps, and an envelope that is a oneOf with no version of its own", () => {
    useVersion(2);
    schema("a.json", {
      title: "Item",
      type: "object",
      additionalProperties: false,
      properties: { schema_version: { const: 2 } },
    });
    schema("b.json", {
      title: "Envelope",
      oneOf: [{ $ref: "#/$defs/Many" }, { $ref: "#/$defs/Mixed" }],
      $defs: {
        Many: {
          type: "object",
          additionalProperties: false,
          required: ["e"],
          properties: { e: { type: "array", minItems: 1, maxItems: 10, items: { $ref: "a.json" } } },
        },
        Mixed: {
          type: "object",
          additionalProperties: false,
          properties: { e: { type: "array", items: { oneOf: [{ $ref: "a.json" }, { type: "string" }] } } },
        },
      },
    });

    const out = generate(dir);
    expect(out).toContain("export interface Many {\n  e: [Item, ...Item[]];\n}");
    expect(out).toContain("export interface Mixed {\n  e?: (Item | string)[];\n}");
    expect(out).toContain("export const MANY_MAX_ITEMS = { e: 10 } as const;");
    expect(out).not.toContain("MIXED_MAX_ITEMS");
    expect(out).toContain("export type Envelope = Many | Mixed;");
    expect(out).not.toContain("ENVELOPE_FIELDS");
    expect(out).toContain("export const SCHEMA_VERSION = 2;");
  });

  it("types the properties a oneOf branch's siblings have and it lacks as never, through nested oneOfs", () => {
    schema("a.json", {
      title: "Envelope",
      oneOf: [{ $ref: "#/$defs/Counted" }, { $ref: "#/$defs/Either" }],
      $defs: {
        Counted: {
          type: "object",
          additionalProperties: false,
          properties: { n: { type: "number" }, seq: { type: "integer" }, e: { type: "string" } },
        },
        Either: { oneOf: [{ $ref: "#/$defs/Plain" }, { $ref: "#/$defs/Tagged" }] },
        Plain: { type: "object", additionalProperties: false, properties: { e: { type: "string" } } },
        Tagged: { type: "object", additionalProperties: false, properties: { e: { type: "string" }, tag: { type: "string" } } },
        Loose: { oneOf: [{ $ref: "#/$defs/Plain" }, { type: "string" }] },
      },
    });
    schema("b.json", { title: "Item", type: "object", additionalProperties: false, properties: { schema_version: { const: 1 } } });

    const out = generate(dir);
    expect(out).toContain("export interface Counted {\n  n?: number;\n  seq?: number;\n  e?: string;\n  tag?: never;\n}");
    expect(out).toContain("export interface Plain {\n  e?: string;\n  n?: never;\n  seq?: never;\n  tag?: never;\n}");
    expect(out).toContain("export interface Tagged {\n  e?: string;\n  tag?: string;\n  n?: never;\n  seq?: never;\n}");
    expect(out).toContain("export interface Item {\n  schema_version?: 1;\n}");
    expect(out).toContain('export const PLAIN_FIELDS = ["e"] as const;');
  });

  it("refuses an array without items", () => {
    schema("a.json", {
      title: "Thing",
      type: "object",
      additionalProperties: false,
      properties: { schema_version: { const: 1 }, list: { type: "array" } },
    });
    expect(() => generate(dir)).toThrow("an array needs items");
  });

  it("refuses schemas none of which declares a version", () => {
    schema("a.json", { title: "Thing", type: "object", additionalProperties: false, properties: { n: { type: "string" } } });
    expect(() => generate(dir)).toThrow("no schema declares schema_version");
  });

  it("refuses an object that nests itself", () => {
    schema("a.json", {
      title: "Thing",
      type: "object",
      additionalProperties: false,
      properties: { schema_version: { const: 1 }, self: { $ref: "a.json" } },
    });
    expect(() => generate(dir)).toThrow("Thing nests itself");
  });

  it("refuses a keyword it can't type, rather than loosen the type", () => {
    schema("a.json", {
      title: "Thing",
      type: "object",
      additionalProperties: false,
      properties: { schema_version: { const: 1 }, n: { anyOf: [{ type: "string" }] } },
    });
    expect(() => generate(dir)).toThrow("unsupported keyword anyOf");
  });

  it("refuses a required field the object doesn't list", () => {
    schema("a.json", {
      title: "Thing",
      type: "object",
      additionalProperties: false,
      required: ["schema_version", "missing"],
      properties: { schema_version: { const: 1 } },
    });
    expect(() => generate(dir)).toThrow("Thing requires missing, which it doesn't list");
  });

  it("refuses an object that allows other properties", () => {
    schema("a.json", { title: "Thing", type: "object", properties: { schema_version: { const: 1 } } });
    expect(() => generate(dir)).toThrow("additionalProperties: false");
  });

  it("refuses schemas that disagree on the version", () => {
    for (const [file, version] of [["a.json", 1], ["b.json", 2]] as const) {
      schema(file, {
        title: file === "a.json" ? "A" : "B",
        type: "object",
        additionalProperties: false,
        properties: { schema_version: { const: version } },
      });
    }
    expect(() => generate(dir)).toThrow("B.schema_version is const 2, not 1 as its directory v1");
  });

  it("refuses a schema copied to v<N+1> whose schema_version is still N, in $defs too", () => {
    useVersion(2);
    schema("a.json", {
      title: "Envelope",
      oneOf: [{ $ref: "#/$defs/Event" }],
      $defs: {
        Version: { const: 1 },
        Event: { type: "object", additionalProperties: false, properties: { schema_version: { $ref: "#/$defs/Version" } } },
      },
    });
    expect(() => generate(dir)).toThrow("Event.schema_version is const 1, not 2 as its directory v2");
  });

  it("refuses a schema whose $id isn't its own path in v<N>", () => {
    useVersion(2);
    schema("a.json", {
      $id: "https://example.test/schema/v1/a.json",
      title: "Thing",
      type: "object",
      additionalProperties: false,
      properties: { schema_version: { const: 2 } },
    });
    expect(() => generate(dir)).toThrow("a.json: its $id must end in /v2/a.json");
  });

  it("refuses a directory not named v<N>", () => {
    const other = join(root, "draft");
    mkdirSync(other);
    expect(() => generate(other)).toThrow("a schema directory is named v<N>");
  });

  it.each([
    ["allOf", { allOf: [{ required: ["n"] }] }],
    ["dependentRequired", { dependentRequired: { n: ["m"] } }],
    ["minProperties", { minProperties: 1 }],
    ["maxProperties", { maxProperties: 1 }],
  ])("refuses an object's own keyword %s it doesn't keep", (keyword, extra) => {
    schema("a.json", {
      title: "Thing",
      type: "object",
      additionalProperties: false,
      properties: { schema_version: { const: 1 }, n: { type: "string" }, m: { type: "string" } },
      $defs: { Part: { type: "object", additionalProperties: false, properties: { x: { type: "string" } }, ...extra } },
    });
    expect(() => generate(dir)).toThrow(`Part has keyword ${keyword}, which the generator doesn't keep`);
  });

  it("refuses a map's keyword, or its propertyNames' rule, it doesn't keep", () => {
    schema("a.json", {
      title: "Thing",
      type: "object",
      additionalProperties: false,
      properties: { schema_version: { const: 1 } },
      $defs: { Bag: { type: "object", required: ["a"], additionalProperties: { type: "string" } } },
    });
    expect(() => generate(dir)).toThrow("Bag has keyword required");
    schema("a.json", {
      title: "Thing",
      type: "object",
      additionalProperties: false,
      properties: { schema_version: { const: 1 } },
      $defs: { Bag: { type: "object", propertyNames: { type: "string", maxLength: 3 }, additionalProperties: { type: "string" } } },
    });
    expect(() => generate(dir)).toThrow("Bag's propertyNames has keyword maxLength");
  });

  it("derives caps and shapes through a $ref to a $ref", () => {
    schema("a.json", {
      title: "Thing",
      type: "object",
      additionalProperties: false,
      properties: {
        schema_version: { const: 1 },
        name: { $ref: "#/$defs/Name" },
        list: { $ref: "#/$defs/List" },
        part: { $ref: "#/$defs/PartAlias" },
        parts: { type: "array", items: { $ref: "#/$defs/PartAlias" } },
      },
      $defs: {
        Name: { $ref: "#/$defs/Text" },
        Text: { type: "string", maxLength: 12 },
        List: { $ref: "#/$defs/Lines" },
        Lines: { type: "array", maxItems: 4, items: { $ref: "#/$defs/PartAlias" } },
        PartAlias: { $ref: "#/$defs/Part" },
        Part: { type: "object", additionalProperties: false, properties: { x: { type: "string" } } },
      },
    });

    const out = generate(dir);
    expect(out).toContain("export const THING_MAX_LENGTH = { name: 12 } as const;");
    expect(out).toContain("export const THING_MAX_ITEMS = { list: 4 } as const;");
    expect(out).toContain("nested: { part: PART_SHAPE }, items: { list: PART_SHAPE, parts: PART_SHAPE }, maps: {} } as const;");
  });

  it("refuses a $ref with a rule beside it, which following it would lose", () => {
    schema("a.json", {
      title: "Thing",
      type: "object",
      additionalProperties: false,
      properties: { schema_version: { const: 1 }, name: { $ref: "#/$defs/Text", maxLength: 3 } },
      $defs: { Text: { type: "string" } },
    });
    expect(() => generate(dir)).toThrow("$ref #/$defs/Text has maxLength beside it");
  });

  it("refuses a rule inside a scalar oneOf's branch, which no shape can keep", () => {
    schema("a.json", {
      title: "Thing",
      type: "object",
      additionalProperties: false,
      properties: {
        schema_version: { const: 1 },
        code: { oneOf: [{ type: "string", maxLength: 3 }, { $ref: "#/$defs/Long" }] },
      },
      $defs: { Long: { type: "string", pattern: "^x" } },
    });
    expect(() => generate(dir)).toThrow("a oneOf branch of Thing.code has keyword maxLength");
  });

  it("generates no shape for an object with a field no shape can check, nor for objects that nest it", () => {
    schema("a.json", {
      title: "Thing",
      type: "object",
      additionalProperties: false,
      properties: {
        schema_version: { const: 1 },
        holder: { $ref: "#/$defs/Holder" },
        ok: { $ref: "#/$defs/Leaf" },
      },
      $defs: {
        Leaf: { type: "object", additionalProperties: false, properties: { x: { type: "string" } } },
        Other: { type: "object", additionalProperties: false, properties: { y: { type: "string" } } },
        Holder: {
          type: "object",
          additionalProperties: false,
          properties: { either: { oneOf: [{ $ref: "#/$defs/Leaf" }, { $ref: "#/$defs/Other" }] } },
        },
        Tags: { type: "object", additionalProperties: false, properties: { tags: { type: "array", items: { type: "string" } } } },
        Open: { type: "object", additionalProperties: false, properties: { open: { type: "object" } } },
      },
    });

    const out = generate(dir);
    expect(out).toContain("export const LEAF_SHAPE = ");
    expect(out).toContain('export const HOLDER_FIELDS = ["either"] as const;');
    for (const name of ["HOLDER", "THING", "TAGS", "OPEN"]) expect(out).not.toContain(`${name}_SHAPE`);
  });

  it("refuses a $ref that resolves to nothing", () => {
    schema("a.json", {
      title: "Thing",
      type: "object",
      additionalProperties: false,
      properties: { schema_version: { const: 1 }, x: { $ref: "other.json#/$defs/Missing" } },
    });
    expect(() => generate(dir)).toThrow("names no schema");
  });
});
