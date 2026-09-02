import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type ImportLine,
  topLevelImports,
} from "#scripts/check-imports/rules.ts";

const importsIn = (source: string, file = "sample.ts"): ImportLine[] =>
  topLevelImports(file, source);

describe("topLevelImports", () => {
  test("records the line, specifier, and names-only shape", () => {
    expect(importsIn('import { a } from "#types";\n')).toEqual([
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
    expect(importsIn(source)).toEqual([
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
    expect(importsIn('import type { A } from "#types";')[0]?.namesOnly).toBe(
      true,
    );
  });

  test("marks a type-only import as erased before anything runs", () => {
    expect(importsIn('import type { A } from "#types";')[0]?.typeOnly).toBe(
      true,
    );
  });

  test("keeps an inline type import as a possible runtime load", () => {
    expect(importsIn('import { type A } from "#types";')[0]?.typeOnly).toBe(
      false,
    );
  });

  test("marks a value import as surviving to run time", () => {
    expect(importsIn('import { a } from "#types";')[0]?.typeOnly).toBe(false);
  });

  test("records a side-effect import", () => {
    const [entry] = importsIn('import "#types";');
    expect(entry?.specifier).toBe("#types");
    expect(entry?.namesOnly).toBe(false);
  });

  test("counts an empty named import as names-only", () => {
    expect(importsIn('import {} from "#types";')[0]?.namesOnly).toBe(true);
    expect(importsIn('import /* from {} */ "#types";')[0]?.namesOnly).toBe(
      false,
    );
  });

  test("ends an import with no semicolon", () => {
    expect(importsIn('import { a } from "#types"')).toEqual([
      {
        line: 1,
        namesOnly: true,
        reExport: false,
        specifier: "#types",
        typeOnly: false,
      },
    ]);
  });

  test("reads a from whose specifier waits on the next line", () => {
    const expected = [
      {
        line: 1,
        namesOnly: true,
        reExport: false,
        specifier: "#shared/a.ts",
        typeOnly: false,
      },
    ];
    expect(importsIn('import { A }\n  from\n  "#shared/a.ts";')).toEqual(
      expected,
    );
    expect(importsIn('import { A }\nfrom\n\n"#shared/a.ts";')).toEqual(
      expected,
    );
    expect(importsIn('import { A }\nfrom\n"#shared/a.ts"')).toEqual(expected);
  });

  test("reads the declaration source past comments", () => {
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
    expect(importsIn(lineCommented)).toEqual(expected);
    const blockCommented = [
      "import {",
      "  /* keep, */ thing,",
      '} from "./right.ts"; /* from "./wrong.ts" */',
    ].join("\n");
    expect(importsIn(blockCommented)).toEqual(expected);
    const spanning = [
      "import {",
      "  /*",
      '  from "./wrong.ts"',
      "  */",
      "  thing,",
      '} from "./right.ts";',
    ].join("\n");
    expect(importsIn(spanning)).toEqual(expected);
  });

  test("rejects a recovered declaration tree", () => {
    const source = 'import { x } from "./right.ts"; /* trailing note';
    expect(() => importsIn(source)).toThrow("Unterminated multiline comment");
  });

  test("does not read an import from inside a template", () => {
    const source = [
      "const guide = `Before:",
      "text ${`inner",
      'import { x } from "./wrong.ts";',
      "`} after`;",
      'import { y } from "./right.ts";',
    ].join("\n");
    expect(importsIn(source)).toEqual([
      {
        line: 5,
        namesOnly: true,
        reExport: false,
        specifier: "./right.ts",
        typeOnly: false,
      },
    ]);
  });

  test("keeps a module address that carries its own slashes", () => {
    const source = 'import { x } from "https://deno.land/x/mod.ts"; // note';
    expect(importsIn(source)[0]?.specifier).toBe("https://deno.land/x/mod.ts");
  });

  test("records a re-export", () => {
    const [entry] = importsIn('export { a } from "#types";');
    expect(entry?.reExport).toBe(true);
    expect(entry?.specifier).toBe("#types");
  });

  test("records an indented import", () => {
    expect(importsIn('  import { a } from "#types";')).toHaveLength(1);
  });

  test("reads no import from inside a continued string", () => {
    const source = [
      "const sample = 'text\\",
      'import { x } from "./wrong.ts";\\',
      "finish';",
    ].join("\n");
    expect(importsIn(source)).toEqual([]);
  });

  test("keeps imports past patterns with comment-like text", () => {
    for (const value of ["/[/*]/", "! /[/*]/"]) {
      const source = `const kinds = ${value};\nimport { a } from "#types";`;
      expect(importsIn(source)[0]?.specifier).toBe("#types");
    }
  });

  test("keeps imports past division after asserted or quoted values", () => {
    for (const value of ["total!", "amount`6`", '"6"', "'6'"]) {
      const source = `const ratio = ${value} / divisor;\nimport { a } from "#types";`;
      expect(importsIn(source)[0]?.specifier).toBe("#types");
    }
  });

  test("records a star re-export", () => {
    expect(importsIn('export * from "#types";')[0]?.specifier).toBe("#types");
  });

  test("marks a type-only re-export as erased", () => {
    expect(importsIn('export type { A } from "#types";')[0]?.typeOnly).toBe(
      true,
    );
  });

  test("keeps an inline type re-export as a possible runtime load", () => {
    expect(importsIn('export { type A } from "#types";')[0]?.typeOnly).toBe(
      false,
    );
  });

  test("names no module for a local export", () => {
    expect(importsIn("export { a };\n")).toEqual([]);
  });

  test("reads the import after a local export", () => {
    const source = 'export { a };\nimport { b } from "#types";\n';
    expect(importsIn(source)[0]?.line).toBe(2);
  });

  test("marks an import as not a re-export", () => {
    expect(importsIn('import { a } from "#types";')[0]?.reExport).toBe(false);
  });

  test("does not count namespace or default imports as names-only", () => {
    expect(importsIn('import * as t from "#types";')[0]?.namesOnly).toBe(false);
    expect(importsIn('import t from "#types";')[0]?.namesOnly).toBe(false);
  });

  test("keeps reading after a side-effect import", () => {
    const source = 'import "#shared/boot.ts";\nimport { a } from "#types";\n';
    expect(importsIn(source).map((entry) => entry.specifier)).toEqual([
      "#shared/boot.ts",
      "#types",
    ]);
  });

  test("uses the TypeScript dialect selected by the file path", () => {
    const source = 'const value = <Thing>input;\nimport "#types";';
    expect(importsIn(source, "sample.ts")[0]?.specifier).toBe("#types");
  });
});
