import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generate, GENERATED_FILE, schemaVersions, SCHEMA_ROOT } from "../scripts/gen-wire.mjs";

describe("gen-wire", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gen-wire-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function schema(file: string, body: Record<string, unknown>): void {
    writeFileSync(join(dir, file), JSON.stringify(body));
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
      properties: { schema_version: { const: 1 }, part: { $ref: "b.json#/$defs/Part" }, open: { type: "object" } },
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
    expect(out).toContain('export const THING_TYPES = { schema_version: "integer", part: "object", open: "object" } as const;');
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
        tags: { type: "array", items: { type: "string" } },
      },
      $defs: {
        Line: { type: "object", additionalProperties: false, required: ["sku"], properties: { sku: { type: "string", maxLength: 9 } } },
      },
    });

    const out = generate(dir);
    expect(out).toContain("export interface Order {\n  schema_version?: 1;\n  lines?: Line[];\n  tags?: string[];\n}");
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
    expect(out).toContain("minimum: THING_MINIMUM, pattern: THING_PATTERN,");
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
    expect(out).toContain("export interface Many {\n  e: Item[];\n}");
    expect(out).toContain("export interface Mixed {\n  e?: (Item | string)[];\n}");
    expect(out).toContain("export const MANY_MAX_ITEMS = { e: 10 } as const;");
    expect(out).not.toContain("MIXED_MAX_ITEMS");
    expect(out).toContain("export type Envelope = Many | Mixed;");
    expect(out).not.toContain("ENVELOPE_FIELDS");
    expect(out).toContain("export const SCHEMA_VERSION = 2;");
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
    expect(() => generate(dir)).toThrow("disagree on schema_version");
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
