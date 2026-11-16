// The Community Template Gallery's package (AAI-156): metadata.yaml, the licence, the template's
// gallery header and the documentation it links. The history check runs here against a stand-in
// history; `pnpm gtm:check` runs it against git, which CI's checkout may not have in full.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkHistory, GalleryError, parseMetadata, type History } from "../scripts/gtm-gallery.mjs";

const ROOT = join(__dirname, "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

const metadata = (versions: string): string =>
  `homepage: "https://serversider.com"\ndocumentation: "https://example.com/docs"\nversions:\n${versions}`;

describe("metadata.yaml", () => {
  const parsed = parseMetadata(read("metadata.yaml"));

  it("is in the gallery's format", () => {
    expect(parsed.versions.length).toBeGreaterThan(0);
  });

  it("links documentation that is in this repo", () => {
    const prefix = "https://github.com/Amanda-AI-AB/amandatracker-tag/blob/main/";
    expect(parsed.documentation.startsWith(prefix)).toBe(true);
    expect(existsSync(join(ROOT, parsed.documentation.slice(prefix.length)))).toBe(true);
  });
});

describe("the package", () => {
  it("is licensed Apache-2.0", () => {
    expect(read("LICENSE")).toMatch(/^\s*Apache License\s+Version 2\.0, January 2004/);
    expect(JSON.parse(read("package.json")).license).toBe("Apache-2.0");
  });

  it("has the template, starting with the gallery's terms of service", () => {
    const template = read("template.tpl");
    expect(template.startsWith("___TERMS_OF_SERVICE___\n")).toBe(true);
    expect(template).toContain("https://developers.google.com/tag-manager/gallery-tos");
    for (const section of ["INFO", "TEMPLATE_PARAMETERS", "SANDBOXED_JS_FOR_WEB_TEMPLATE", "WEB_PERMISSIONS", "TESTS"]) {
      expect(template).toMatch(new RegExp(`^___${section}___$`, "m"));
    }
  });
});

describe("parseMetadata", () => {
  it("reads the versions, newest first as listed", () => {
    const parsed = parseMetadata(metadata(`  - sha: ${B}\n    changeNotes: Second.\n  - sha: ${A}\n    changeNotes: First.\n`));
    expect(parsed.versions).toEqual([
      { sha: B, changeNotes: "Second." },
      { sha: A, changeNotes: "First." },
    ]);
  });

  it.each([
    ["no versions", metadata("  []\n")],
    ["a short sha", metadata(`  - sha: ${A.slice(0, 7)}\n    changeNotes: First.\n`)],
    ["an uppercase sha", metadata(`  - sha: ${A.toUpperCase()}\n    changeNotes: First.\n`)],
    ["no change notes", metadata(`  - sha: ${A}\n`)],
    ["empty change notes", metadata(`  - sha: ${A}\n    changeNotes: " "\n`)],
    ["a version listed twice", metadata(`  - sha: ${A}\n    changeNotes: a\n  - sha: ${A}\n    changeNotes: b\n`)],
    ["an unknown version key", metadata(`  - sha: ${A}\n    changeNotes: a\n    tag: v1\n`)],
    ["an unknown key", `name: x\n${metadata(`  - sha: ${A}\n    changeNotes: a\n`)}`],
    ["an http homepage", `homepage: "http://serversider.com"\ndocumentation: "https://example.com/docs"\nversions:\n  - sha: ${A}\n    changeNotes: a\n`],
    ["no documentation", `homepage: "https://serversider.com"\nversions:\n  - sha: ${A}\n    changeNotes: a\n`],
    ["a list", "- a\n"],
  ])("refuses %s", (_, text) => {
    expect(() => parseMetadata(text)).toThrow(GalleryError);
  });
});

describe("checkHistory", () => {
  // main: A <- B <- C, with template.tpl at each; C's is "v3".
  const parents: Record<string, string | undefined> = { [A]: undefined, [B]: A, [C]: B };
  const templates: Record<string, string> = { [A]: "v1", [B]: "v2", [C]: "v3" };
  const history: History = {
    isAncestor(ancestor, descendant) {
      const at = descendant === "main" ? C : descendant;
      if (!(ancestor in parents) || !(at in parents)) throw new GalleryError(`unknown commit`);
      for (let sha: string | undefined = at; sha !== undefined; sha = parents[sha]) if (sha === ancestor) return true;
      return false;
    },
    fileAt: (sha) => templates[sha] ?? null,
  };
  const check = (shas: string[], template: string): void =>
    checkHistory(
      { homepage: "https://a.b", documentation: "https://a.b", versions: shas.map((sha) => ({ sha, changeNotes: "x" })) },
      history,
      "main",
      template,
    );

  it("accepts versions on main, newest first, the newest being the checkout's template", () => {
    expect(() => check([C, A], "v3")).not.toThrow();
  });

  it("refuses a template changed since the newest version", () => {
    expect(() => check([B, A], "v3")).toThrow(/template\.tpl has changed since the newest version/);
  });

  it("refuses versions listed oldest first", () => {
    expect(() => check([A, C], "v1")).toThrow(/list the newest first/);
  });

  it("refuses a version that isn't on main", () => {
    const D = "d".repeat(40);
    parents[D] = C;
    templates[D] = "v4";
    try {
      expect(() => check([D], "v4")).toThrow(/is not on main/);
    } finally {
      delete parents[D];
      delete templates[D];
    }
  });

  it("refuses a version without template.tpl", () => {
    delete templates[A];
    try {
      expect(() => check([C, A], "v3")).toThrow(/has no template\.tpl/);
    } finally {
      templates[A] = "v1";
    }
  });
});
