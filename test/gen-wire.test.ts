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
    expect(out).toContain(
      "export const THING_SHAPE = { fields: THING_FIELDS, required: THING_REQUIRED, maxLength: THING_MAX_LENGTH, nested: {} } as const;",
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
      "export const PART_SHAPE = { fields: PART_FIELDS, required: PART_REQUIRED, maxLength: PART_MAX_LENGTH, nested: {} } as const;",
    );
    expect(out).toContain(
      "export const THING_SHAPE = { fields: THING_FIELDS, required: THING_REQUIRED, maxLength: {}, nested: { part: PART_SHAPE } } as const;",
    );
    expect(out.indexOf("PART_SHAPE = ")).toBeLessThan(out.indexOf("THING_SHAPE = "));
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
