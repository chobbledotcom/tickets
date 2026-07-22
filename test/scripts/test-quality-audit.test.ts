import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { findAssertionlessTests } from "#scripts/test-quality-audit.ts";

describe("test quality audit", () => {
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

    expect(findAssertionlessTests("fixture.test.ts", content)).toEqual([]);
  });

  test("ignores test declarations inside lexical text", () => {
    const content = [
      `const quoted = 'test("quoted", () => {})';`,
      'const template = `test("template", () => {})`;',
      '// test("line comment", () => {});',
      '/* test("block comment", () => {}); */',
      'test("real", () => expect(1).toBe(1));',
    ].join("\n");

    expect(findAssertionlessTests("fixture.test.ts", content)).toEqual([]);
  });
});
