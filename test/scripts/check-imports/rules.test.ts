import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type Alias,
  bestSpelling,
  findImportIssues,
  formatIssue,
  resolveSpecifier,
  stripComments,
  topLevelImports,
} from "#scripts/check-imports/rules.ts";

const ALIASES: Alias[] = [
  { name: "#db/", target: "./src/shared/db/" },
  { name: "#jsx/jsx-runtime", target: "./src/shared/jsx/jsx-runtime.ts" },
  { name: "#shared/", target: "./src/shared/" },
  { name: "#src/", target: "./src/" },
  { name: "#types", target: "./src/shared/types.ts" },
];

const messages = (source: string, aliases: Alias[] = ALIASES): string[] =>
  findImportIssues(source, aliases).map((issue) => issue.message);

describe("resolveSpecifier", () => {
  test("reads a folder alias as the folder plus the rest", () => {
    expect(resolveSpecifier(ALIASES, "#db/client.ts")).toBe(
      "./src/shared/db/client.ts",
    );
  });

  test("reads a whole-module alias as that module", () => {
    expect(resolveSpecifier(ALIASES, "#types")).toBe("./src/shared/types.ts");
  });

  test("lets the longest matching alias win, as the runtime does", () => {
    const aliases: Alias[] = [
      { name: "#a/", target: "./one/" },
      { name: "#a/b/", target: "./two/" },
    ];
    expect(resolveSpecifier(aliases, "#a/b/c.ts")).toBe("./two/c.ts");
  });

  test("returns null for a specifier no alias covers", () => {
    expect(resolveSpecifier(ALIASES, "#nope/x.ts")).toBeNull();
  });

  test("does not read a whole-module alias as a folder", () => {
    expect(resolveSpecifier(ALIASES, "#types/extra.ts")).toBeNull();
  });
});

describe("bestSpelling", () => {
  test("prefers the shortest alias that reaches the file", () => {
    expect(bestSpelling(ALIASES, "./src/shared/db/client.ts")).toBe(
      "#db/client.ts",
    );
  });

  test("prefers a whole-module alias over spelling out the folder", () => {
    expect(bestSpelling(ALIASES, "./src/shared/types.ts")).toBe("#types");
  });

  test("never proposes an alias that omits the file extension", () => {
    expect(bestSpelling(ALIASES, "./src/shared/jsx/jsx-runtime.ts")).toBe(
      "#shared/jsx/jsx-runtime.ts",
    );
  });

  test("breaks a tie alphabetically so one file gets one answer", () => {
    const aliases: Alias[] = [
      { name: "#bb/", target: "./x/" },
      { name: "#aa/", target: "./x/" },
    ];
    expect(bestSpelling(aliases, "./x/f.ts")).toBe("#aa/f.ts");
  });

  test("keeps the shortest alias over an alphabetically earlier longer one", () => {
    const aliases: Alias[] = [
      { name: "#z/", target: "./x/" },
      { name: "#aaa/", target: "./x/" },
    ];
    expect(bestSpelling(aliases, "./x/f.ts")).toBe("#z/f.ts");
  });

  test("returns null when no alias reaches the file", () => {
    expect(bestSpelling(ALIASES, "./elsewhere/f.ts")).toBeNull();
  });
});

describe("stripComments", () => {
  test("takes a comment out and keeps the line it spanned", () => {
    expect(stripComments("a/*x*/b")).toBe("ab");
    expect(stripComments("a/*x\ny*/b")).toBe("a\nb");
  });

  test("takes a template's contents and keeps only its line breaks", () => {
    expect(stripComments("a`x\ny`b")).toBe("a\nb");
    expect(stripComments("`x`")).toBe("");
  });

  test("keeps whatever a string quotes, in either quote style", () => {
    expect(stripComments("a'b//c'd")).toBe("a'b//c'd");
    expect(stripComments('a"b//c"d')).toBe('a"b//c"d');
  });
});

describe("topLevelImports", () => {
  test("records the line, specifier, and names-only shape", () => {
    expect(topLevelImports('import { a } from "#types";\n')).toEqual([
      {
        line: 1,
        namesOnly: true,
        reExport: false,
        specifier: "#types",
        typeOnly: false,
      },
    ]);
  });

  test("reports a wrapped import at the line it starts on", () => {
    const source = 'const x = 1;\nimport {\n  a,\n  b,\n} from "#types";\n';
    expect(topLevelImports(source)).toEqual([
      {
        line: 2,
        namesOnly: true,
        reExport: false,
        specifier: "#types",
        typeOnly: false,
      },
    ]);
  });

  test("counts a type-only import as names-only", () => {
    expect(
      topLevelImports('import type { A } from "#types";')[0]?.namesOnly,
    ).toBe(true);
  });

  test("marks a type-only import as erased before anything runs", () => {
    expect(
      topLevelImports('import type { A } from "#types";')[0]?.typeOnly,
    ).toBe(true);
  });

  test("marks an import that brings in a value as surviving to run time", () => {
    expect(topLevelImports('import { a } from "#types";')[0]?.typeOnly).toBe(
      false,
    );
  });

  test("records a side-effect import, which names its module without a from", () => {
    const [entry] = topLevelImports('import "#types";');
    expect(entry?.specifier).toBe("#types");
    expect(entry?.namesOnly).toBe(false);
  });

  test("ends an import with no semicolon, the way JavaScript allows", () => {
    expect(topLevelImports('import { a } from "#types"')).toEqual([
      {
        line: 1,
        namesOnly: true,
        reExport: false,
        specifier: "#types",
        typeOnly: false,
      },
    ]);
  });

  test("reads the statement's own from, not one inside a comment", () => {
    const expected = [
      {
        line: 1,
        namesOnly: true,
        reExport: false,
        specifier: "./right.ts",
        typeOnly: false,
      },
    ];
    const lineCommented = [
      "import {",
      '  // from "./wrong.ts"',
      "  thing,",
      '} from "./right.ts";',
    ].join("\n");
    expect(topLevelImports(lineCommented)).toEqual(expected);
    const blockCommented = [
      "import {",
      "  /* keep, */ thing,",
      '} from "./right.ts"; /* from "./wrong.ts" */',
    ].join("\n");
    expect(topLevelImports(blockCommented)).toEqual(expected);
    // A block comment that never closes on the line takes the rest of it.
    const unclosed = 'import { x } from "./right.ts"; /* trailing note';
    expect(topLevelImports(unclosed)).toEqual([
      {
        line: 1,
        namesOnly: true,
        reExport: false,
        specifier: "./right.ts",
        typeOnly: false,
      },
    ]);
    // A comment that spans lines stays absent on each line it covers.
    const spanning = [
      "import {",
      "  /*",
      '  from "./wrong.ts"',
      "  */",
      "  thing,",
      '} from "./right.ts";',
    ].join("\n");
    expect(topLevelImports(spanning)).toEqual(expected);
    // A multiline template keeps only its line breaks, so an example import
    // written at column zero inside one is not the real thing.
    const documented = [
      "const guide = `Before:",
      'import { x } from "./wrong.ts";',
      "`;",
      'import { thing } from "./right.ts";',
    ].join("\n");
    expect(topLevelImports(documented)).toEqual([
      {
        line: 4,
        namesOnly: true,
        reExport: false,
        specifier: "./right.ts",
        typeOnly: false,
      },
    ]);
  });

  test("keeps a module address that carries its own slashes", () => {
    const source =
      'import { x } from "https://deno.land/x/mod.ts"; // from "./wrong.ts"';
    expect(topLevelImports(source)[0]?.specifier).toBe(
      "https://deno.land/x/mod.ts",
    );
  });

  test("records a re-export, which loads its module just as an import does", () => {
    const [entry] = topLevelImports('export { a } from "#types";');
    expect(entry?.reExport).toBe(true);
    expect(entry?.specifier).toBe("#types");
  });

  test("records a star re-export", () => {
    expect(topLevelImports('export * from "#types";')[0]?.specifier).toBe(
      "#types",
    );
  });

  test("marks a type-only re-export as erased before anything runs", () => {
    expect(
      topLevelImports('export type { A } from "#types";')[0]?.typeOnly,
    ).toBe(true);
  });

  test("names no module for an export that has no from", () => {
    expect(topLevelImports("export { a };\n")).toEqual([]);
  });

  test("reads the import after an export that names no module", () => {
    const source = 'export { a };\nimport { b } from "#types";\n';
    expect(topLevelImports(source)[0]?.line).toBe(2);
  });

  test("marks an import as not a re-export", () => {
    expect(topLevelImports('import { a } from "#types";')[0]?.reExport).toBe(
      false,
    );
  });

  test("does not count a namespace import as names-only", () => {
    expect(topLevelImports('import * as t from "#types";')[0]?.namesOnly).toBe(
      false,
    );
  });

  test("does not count a default import as names-only", () => {
    expect(topLevelImports('import t from "#types";')[0]?.namesOnly).toBe(
      false,
    );
  });

  test("ignores an indented import, which is inside a string", () => {
    expect(topLevelImports('  import { a } from "#types";\n')).toEqual([]);
  });

  test("keeps reading after a side-effect import", () => {
    const source = 'import "#shared/boot.ts";\nimport { a } from "#types";\n';
    expect(topLevelImports(source).map((entry) => entry.specifier)).toEqual([
      "#shared/boot.ts",
      "#types",
    ]);
  });
});

describe("findImportIssues", () => {
  test("leaves an import beside a re-export of the same module alone", () => {
    const source = 'import { a } from "#types";\nexport { b } from "#types";\n';
    expect(messages(source)).toEqual([]);
  });

  test("flags one module imported by two statements", () => {
    const source =
      'import type { A } from "#types";\nimport { b } from "#types";\n';
    expect(messages(source)).toEqual([
      'imports "#types" again — merge into one statement, marking the type-only names with an inline `type`',
    ]);
  });

  test("points the split-import finding at the second statement", () => {
    const source =
      'import type { A } from "#types";\nimport { b } from "#types";\n';
    expect(findImportIssues(source, ALIASES)[0]?.line).toBe(2);
  });

  test("accepts a namespace import beside named ones", () => {
    const source =
      'import * as t from "#types";\nimport { b } from "#types";\n';
    expect(messages(source)).toEqual([]);
  });

  test("accepts one module imported once", () => {
    expect(messages('import { a, type B } from "#types";\n')).toEqual([]);
  });

  test("flags a module spelled longer than its alias allows", () => {
    expect(messages('import { a } from "#shared/db/client.ts";\n')).toEqual([
      'imports "#shared/db/client.ts" — write "#db/client.ts" instead',
    ]);
  });

  test("flags a whole-module alias spelled out as a path", () => {
    expect(messages('import { a } from "#shared/types.ts";\n')).toEqual([
      'imports "#shared/types.ts" — write "#types" instead',
    ]);
  });

  test("accepts a module already spelled its shortest way", () => {
    expect(messages('import { a } from "#db/client.ts";\n')).toEqual([]);
  });

  test("leaves a bare package specifier alone", () => {
    expect(messages('import { expect } from "@std/expect";\n')).toEqual([]);
  });

  test("leaves a relative specifier alone", () => {
    expect(messages('import { a } from "./sibling.ts";\n')).toEqual([]);
  });

  test("leaves an alias the table does not know alone", () => {
    expect(messages('import { a } from "#unknown/x.ts";\n')).toEqual([]);
  });

  test("reports both kinds of issue in line order", () => {
    const source = [
      'import { a } from "#shared/db/client.ts";',
      'import type { B } from "#types";',
      'import { c } from "#types";',
      "",
    ].join("\n");
    expect(
      findImportIssues(source, ALIASES).map((issue) => issue.line),
    ).toEqual([1, 3]);
  });
});

describe("formatIssue", () => {
  test("names the file and line before the message", () => {
    expect(formatIssue("src/a.ts", { line: 7, message: "went wrong" })).toBe(
      "src/a.ts:7 went wrong",
    );
  });
});
