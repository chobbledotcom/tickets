import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { findImportIssues } from "#scripts/check-imports/rules.ts";
import { ALIASES, messages } from "./fixtures.ts";

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

  test("flags an empty named import beside another named import", () => {
    const source =
      'import {} from "#types";\nimport { value } from "#types";\n';
    expect(messages(source)).toEqual([
      'imports "#types" again — merge into one statement, marking the type-only names with an inline `type`',
    ]);
  });

  test("points the split-import finding at the second statement", () => {
    const source =
      'import type { A } from "#types";\nimport { b } from "#types";\n';
    expect(findImportIssues("sample.ts", source, ALIASES)[0]?.line).toBe(2);
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

  test("leaves package, relative, and unknown specifiers alone", () => {
    expect(messages('import { expect } from "@std/expect";\n')).toEqual([]);
    expect(messages('import { a } from "./sibling.ts";\n')).toEqual([]);
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
      findImportIssues("sample.ts", source, ALIASES).map((issue) => issue.line),
    ).toEqual([1, 3]);
  });
});
