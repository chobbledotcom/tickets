import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { shapeOf } from "#scripts/typescript-lex.ts";

describe("shapeOf slash basics", () => {
  test("gives two patterns that differ only in what they match one shape", () => {
    expect(shapeOf("/foo/.test(s)")).toEqual(shapeOf("/bar-baz/i.test(s)"));
  });

  test("reads a slash inside a character class as part of the pattern", () => {
    expect(shapeOf("/a[/*]b/.test(s) && s.length")).toEqual([
      "RE",
      ".",
      "ID",
      "(",
      "ID",
      ")",
      "&",
      "&",
      "ID",
      ".",
      "ID",
    ]);
  });

  test("reads an escaped slash without ending the pattern", () => {
    expect(shapeOf("/a\\/b/.test(s)")).toEqual(shapeOf("/xy/.test(s)"));
  });

  test("still reads a slash after a value as dividing", () => {
    expect(shapeOf("a / b")).toEqual(["ID", "/", "ID"]);
    expect(shapeOf("total() / 2")).toEqual(["ID", "(", ")", "/", "NUM"]);
    expect(shapeOf("total! / divisor")).toEqual(["ID", "!", "/", "ID"]);
    expect(shapeOf("return !/x/.test(s);")).toEqual([
      "return",
      "!",
      "RE",
      ".",
      "ID",
      "(",
      "ID",
      ")",
      ";",
    ]);
  });

  test("reads a step operator as one token", () => {
    expect(shapeOf("_++")).toEqual(["ID", "++"]);
    expect(shapeOf("_--")).toEqual(["ID", "--"]);
    expect(shapeOf("_ + _")).toEqual(["ID", "+", "ID"]);
  });

  test("still reads a slash after a step operator as dividing", () => {
    expect(shapeOf("count++ / divisor")).toEqual(["ID", "++", "/", "ID"]);
    expect(shapeOf("count-- / divisor")).toEqual(["ID", "--", "/", "ID"]);
  });

  test("opens a pattern after a control header", () => {
    expect(shapeOf("if (ready) /foo/.test(value)")).toEqual([
      "if",
      "(",
      "ID",
      ")",
      "RE",
      ".",
      "ID",
      "(",
      "ID",
      ")",
    ]);
    expect(shapeOf("while (a) /x/.test(b)")).toEqual([
      "while",
      "(",
      "ID",
      ")",
      "RE",
      ".",
      "ID",
      "(",
      "ID",
      ")",
    ]);
    expect(shapeOf("for (const a of b) /x/.test(a)")).toEqual([
      "for",
      "(",
      "const",
      "ID",
      "of",
      "ID",
      ")",
      "RE",
      ".",
      "ID",
      "(",
      "ID",
      ")",
    ]);
  });

  test("opens a pattern after for-await but divides an await operand", () => {
    expect(shapeOf("for await (const item of items) /x/.test(item)")).toEqual([
      "for",
      "await",
      "(",
      "const",
      "ID",
      "of",
      "ID",
      ")",
      "RE",
      ".",
      "ID",
      "(",
      "ID",
      ")",
    ]);
    expect(shapeOf("await (total) / 2")).toEqual([
      "await",
      "(",
      "ID",
      ")",
      "/",
      "NUM",
    ]);
    expect(
      shapeOf("for /* each row */ await (const row of rows) /x/(r)"),
    ).toEqual([
      "for",
      "await",
      "(",
      "const",
      "ID",
      "of",
      "ID",
      ")",
      "RE",
      "(",
      "ID",
      ")",
    ]);
  });

  test("reads unmatched brackets as values and a leading brace as a block", () => {
    expect(shapeOf(") / 2")).toEqual([")", "/", "NUM"]);
    expect(shapeOf("} / 2")).toEqual(["}", "/", "NUM"]);
    expect(shapeOf("{} / 2")).toEqual(["{", "}", "RE"]);
    expect(shapeOf("done]: {} / 2")).toEqual(["ID", "]", ":", "{", "}", "RE"]);
  });

  test("still divides after a bracket that ends a call or sum", () => {
    expect(shapeOf("f(g(a)) / 2")).toEqual([
      "ID",
      "(",
      "ID",
      "(",
      "ID",
      ")",
      ")",
      "/",
      "NUM",
    ]);
    expect(shapeOf("(a + b) / 2")).toEqual([
      "(",
      "ID",
      "+",
      "ID",
      ")",
      "/",
      "NUM",
    ]);
  });

  test("still divides inside a braced control body", () => {
    expect(shapeOf("if (a) { b = c() / 2; }")).toContain("/");
  });
});
