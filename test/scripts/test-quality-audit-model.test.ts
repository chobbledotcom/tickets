import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { auditTestContent } from "#scripts/test-quality-audit-model.ts";

describe("test quality audit model", () => {
  test("finds the real end after a closing parenthesis in lexical text", () => {
    const content = [
      'test("handles ) and an escaped quote: \\"", () => {',
      "  const single = ')';",
      "  const template = `contains )`;",
      "  // Ignore ) in a line comment.",
      "  /* Ignore ) in a block comment. */",
      '  expect(single + template).toBe(")contains )");',
      "});",
    ].join("\n");

    expect(auditTestContent("fixture.test.ts", content)).toEqual([]);
  });

  test("ignores test declarations inside lexical text", () => {
    const content = [
      `const quoted = 'test("quoted", () => {})';`,
      'const template = `test("template", () => {})`;',
      '// test("line comment", () => {});',
      '/* test("block comment", () => {}); */',
      'test("real", () => expect(1).toBe(1));',
    ].join("\n");

    expect(auditTestContent("fixture.test.ts", content)).toEqual([]);
  });

  test("ignores weak assertions inside lexical text", () => {
    const content = [
      `const quoted = 'expect(value).toBeDefined()';`,
      "const template = `expect(value).toBeFalsy()`;",
      "// expect(value).toBeTruthy();",
      "/* expect(left && right).toBe(true); */",
    ].join("\n");

    expect(auditTestContent("fixture.test.ts", content)).toEqual([]);
  });

  test("reports tests whose assertion text is only lexical", () => {
    const content = [
      'test("comment", () => {',
      "  // TODO: expect(value).toBe(value);",
      "});",
      'test("string", () => {',
      '  const reminder = "assertEquals(value, expected)";',
      "});",
    ].join("\n");

    expect(auditTestContent("fixture.test.ts", content)).toEqual([
      {
        column: 1,
        line: 1,
        message: "test has no visible assertion",
        path: "fixture.test.ts",
      },
      {
        column: 1,
        line: 4,
        message: "test has no visible assertion",
        path: "fixture.test.ts",
      },
    ]);
  });

  test("reports an assertionless test at its declaration", () => {
    expect(
      auditTestContent(
        "fixture.test.ts",
        'Deno.test("missing", () => doSomething());',
      ),
    ).toEqual([
      {
        column: 1,
        line: 1,
        message: "test has no visible assertion",
        path: "fixture.test.ts",
      },
    ]);
  });

  test("ignores an unfinished test declaration", () => {
    expect(
      auditTestContent("fixture.test.ts", 'test("unfinished", () => {'),
    ).toEqual([]);
  });

  test("keeps scanning after an apostrophe in JSX text", () => {
    const content = [
      'test("renders", () => {',
      "  const node = <p>don't regress</p>;",
      '  expect(String(node)).toContain("regress");',
      "});",
      'test("missing", () => doSomething());',
    ].join("\n");

    expect(auditTestContent("fixture.test.tsx", content)).toEqual([
      {
        column: 1,
        line: 5,
        message: "test has no visible assertion",
        path: "fixture.test.tsx",
      },
    ]);
  });

  test("keeps scanning after comments in a template test title", () => {
    const title = ["test(`handles $", "{/* } */ `inner )`}`, () => {"].join("");
    const content = [
      title,
      "  expect(1).toBe(1);",
      "});",
      'test("missing", () => doSomething());',
    ].join("\n");

    expect(auditTestContent("fixture.test.ts", content)).toEqual([
      {
        column: 1,
        line: 4,
        message: "test has no visible assertion",
        path: "fixture.test.ts",
      },
    ]);
  });

  test("reports each weak assertion kind", () => {
    const content = [
      "expect(value).toBeDefined();",
      "expect(value).toBeFalsy();",
      "expect(left && right).toBe(true);",
    ].join("\n");

    expect(auditTestContent("fixture.test.ts", content)).toEqual([
      {
        column: 1,
        line: 1,
        message:
          "presence-only assertion; prefer checking the value, shape, or invariant",
        path: "fixture.test.ts",
      },
      {
        column: 1,
        line: 2,
        message:
          "truthiness assertion; prefer an exact value or contract-specific matcher",
        path: "fixture.test.ts",
      },
      {
        column: 1,
        line: 3,
        message:
          "compound boolean assertion; split into contract-specific assertions",
        path: "fixture.test.ts",
      },
    ]);
  });
});
