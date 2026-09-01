import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { shapeOf } from "#scripts/check-shapes/shape.ts";
import { interpolated, template } from "./samples.ts";

describe("shapeOf reading a pattern", () => {
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
    // A non-null assertion ends the value it asserts on.
    expect(shapeOf("total! / divisor")).toEqual(["ID", "!", "/", "ID"]);
    // A leading negation ends no value, so the pattern after it opens.
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

  test("reads a step operator as one token, the way JavaScript does", () => {
    expect(shapeOf("_++")).toEqual(["ID", "++"]);
    expect(shapeOf("_--")).toEqual(["ID", "--"]);
    expect(shapeOf("_ + _")).toEqual(["ID", "+", "ID"]);
  });

  test("still reads a slash after a step operator as dividing", () => {
    expect(shapeOf("count++ / divisor")).toEqual(["ID", "++", "/", "ID"]);
    expect(shapeOf("count-- / divisor")).toEqual(["ID", "--", "/", "ID"]);
  });

  test("opens a pattern after a control header's bracket", () => {
    expect(shapeOf("if (ready) /foo/.test(value)")).toEqual(
      shapeOf("if (ok) /bar-baz/.test(text)"),
    );
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
  });

  test("opens a pattern after a while or for header too", () => {
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

  test("opens a pattern after a for-await header, but divides an await operand", () => {
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
    // A comment inside the header sits between the words, not between the
    // words and what they name.
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

  test("reads a bracket that closes nothing as ending a value", () => {
    // Nothing says what such a bracket belongs to, so it takes the reading
    // that all but a control header wants, and the slash divides.
    expect(shapeOf(") / 2")).toEqual([")", "/", "NUM"]);
    expect(shapeOf("} / 2")).toEqual(["}", "/", "NUM"]);
    // A brace at the very head of a body opens a block, with nothing before
    // it to say otherwise, and a label's unmatched closer still reads as a
    // label's.
    expect(shapeOf("{} / 2")).toEqual(["{", "}", "RE"]);
    expect(shapeOf("done]: {} / 2")).toEqual(["ID", "]", ":", "{", "}", "RE"]);
  });

  test("still divides after a bracket that ends a call or a sum", () => {
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

  test("opens a pattern after a brace that closed a block", () => {
    expect(shapeOf("if (ready) {} /foo/.test(value)")).toEqual([
      "if",
      "(",
      "ID",
      ")",
      "{",
      "}",
      "RE",
      ".",
      "ID",
      "(",
      "ID",
      ")",
    ]);
    expect(shapeOf("try {} catch {} /x/.test(s)")).toEqual([
      "try",
      "{",
      "}",
      "catch",
      "{",
      "}",
      "RE",
      ".",
      "ID",
      "(",
      "ID",
      ")",
    ]);
    expect(shapeOf("try {} finally {} /x/.test(s)")).toEqual([
      "try",
      "{",
      "}",
      "finally",
      "{",
      "}",
      "RE",
      ".",
      "ID",
      "(",
      "ID",
      ")",
    ]);
    expect(shapeOf("class Helper {} /foo/.test(value)")).toEqual([
      "class",
      "ID",
      "{",
      "}",
      "RE",
      ".",
      "ID",
      "(",
      "ID",
      ")",
    ]);
    expect(shapeOf("_ = () => {} /x/.test(s)")).toEqual([
      "ID",
      "=",
      "(",
      ")",
      "=>",
      "{",
      "}",
      "RE",
      ".",
      "ID",
      "(",
      "ID",
      ")",
    ]);
  });

  test("reads a label's brace and a case clause's as a block", () => {
    expect(shapeOf("done: {} /foo/.test(value)")).toEqual([
      "ID",
      ":",
      "{",
      "}",
      "RE",
      ".",
      "ID",
      "(",
      "ID",
      ")",
    ]);
    expect(shapeOf('case "all": {} /x/.test(s)')).toEqual([
      "case",
      "STR",
      ":",
      "{",
      "}",
      "RE",
      ".",
      "ID",
      "(",
      "ID",
      ")",
    ]);
    expect(shapeOf("default: {} /x/.test(s)")).toEqual([
      "default",
      ":",
      "{",
      "}",
      "RE",
      ".",
      "ID",
      "(",
      "ID",
      ")",
    ]);
  });

  test("still divides after a brace that holds a ternary arm or a property", () => {
    expect(shapeOf("c ? a : { one: 1 } / 2")).toEqual([
      "ID",
      "?",
      "ID",
      ":",
      "{",
      "ID",
      ":",
      "NUM",
      "}",
      "/",
      "NUM",
    ]);
    expect(shapeOf("c ? a[0]: { one: 1 } / 2")).toEqual([
      "ID",
      "?",
      "ID",
      "[",
      "NUM",
      "]",
      ":",
      "{",
      "ID",
      ":",
      "NUM",
      "}",
      "/",
      "NUM",
    ]);
    expect(shapeOf("c ? (a) : { one: 1 } / 2")).toEqual([
      "ID",
      "?",
      "(",
      "ID",
      ")",
      ":",
      "{",
      "ID",
      ":",
      "NUM",
      "}",
      "/",
      "NUM",
    ]);
    expect(shapeOf("c ? hold(a) : { one: 1 } / 2")).toEqual([
      "ID",
      "?",
      "ID",
      "(",
      "ID",
      ")",
      ":",
      "{",
      "ID",
      ":",
      "NUM",
      "}",
      "/",
      "NUM",
    ]);
    expect(shapeOf("c ? { yes: 1 } : { no: 2 } / 2")).toEqual([
      "ID",
      "?",
      "{",
      "ID",
      ":",
      "NUM",
      "}",
      ":",
      "{",
      "ID",
      ":",
      "NUM",
      "}",
      "/",
      "NUM",
    ]);
    // A property's own value divides inside the object that holds it.
    expect(shapeOf("x = { a: { b } / 2 }")).toEqual([
      "ID",
      "=",
      "{",
      "ID",
      ":",
      "{",
      "ID",
      "}",
      "/",
      "NUM",
      "}",
    ]);
    // A property after a comma is an arm of the object, not a label.
    expect(shapeOf("x = { a: 1, b: { two: 2 } / 2 }")).toEqual([
      "ID",
      "=",
      "{",
      "ID",
      ":",
      "NUM",
      ",",
      "ID",
      ":",
      "{",
      "ID",
      ":",
      "NUM",
      "}",
      "/",
      "NUM",
      "}",
    ]);
  });

  test("still divides after a brace that closed a value", () => {
    expect(shapeOf("half = { one: 1, two: 2 } / 2")).toEqual([
      "ID",
      "=",
      "{",
      "ID",
      ":",
      "NUM",
      ",",
      "ID",
      ":",
      "NUM",
      "}",
      "/",
      "NUM",
    ]);
  });

  test("keeps a pattern whole inside an interpolation after a header", () => {
    // The pattern's own brace is what makes this the boundary scan's
    // business: read as a pattern, its brace cannot close the interpolation.
    expect(
      shapeOf(
        template(interpolated(" (ready) => { if (ready) /}/.test(v); } ")),
      ),
    ).toEqual([
      "STR",
      "(",
      "ID",
      ")",
      "=>",
      "{",
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
      ";",
      "}",
    ]);
    // The tokens of a for-await interpolation body, with and without a
    // comment between the two words of the header.
    const forAwaitBody = [
      "STR",
      "(",
      "ID",
      ")",
      "=>",
      "{",
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
      ";",
      "}",
    ];
    expect(
      shapeOf(
        template(
          interpolated(" (rows) => { for await (const r of rows) /x/(r); } "),
        ),
      ),
    ).toEqual(forAwaitBody);
    expect(
      shapeOf(
        template(
          interpolated(
            " (rows) => { for /* each */ await (const r of rows) /x/(r); } ",
          ),
        ),
      ),
    ).toEqual(forAwaitBody);
    // A regex can end in the very characters that open a comment, and a
    // closer with no opener behind it stops the backward read, so no header
    // is found and the slash after the bracket divides.
    expect(
      shapeOf(template(interpolated(" (rows) => { /x*/ (r) / q; w(r); } "))),
    ).toEqual([
      "STR",
      "(",
      "ID",
      ")",
      "=>",
      "{",
      "RE",
      "(",
      "ID",
      ")",
      "/",
      "ID",
      ";",
      "ID",
      "(",
      "ID",
      ")",
      ";",
      "}",
    ]);
  });

  test("keeps a pattern whole inside an interpolation after return", () => {
    expect(
      shapeOf(template(interpolated(" (() => { return /}/.test(s); })() "))),
    ).toEqual([
      "STR",
      "(",
      "(",
      ")",
      "=>",
      "{",
      "return",
      "RE",
      ".",
      "ID",
      "(",
      "ID",
      ")",
      ";",
      "}",
      ")",
      "(",
      ")",
    ]);
  });

  test("keeps a pattern's brace from closing an interpolation early", () => {
    expect(
      shapeOf(template(interpolated(" _ ? /}/.test(_) : false "))),
    ).toEqual([
      "STR",
      "ID",
      "?",
      "RE",
      ".",
      "ID",
      "(",
      "ID",
      ")",
      ":",
      "false",
    ]);
  });

  test("reads a step operator inside an interpolation, so the slash divides", () => {
    expect(shapeOf(template(interpolated("i++ / n")))).toEqual([
      "STR",
      "ID",
      "++",
      "/",
      "ID",
    ]);
  });

  test("still reads a slash after a value in an interpolation as dividing", () => {
    expect(shapeOf(template(interpolated("a / b")))).toEqual([
      "STR",
      "ID",
      "/",
      "ID",
    ]);
    // A bracket that closes nothing still ends a value inside one.
    expect(shapeOf(template(interpolated(" ) / width ")))).toEqual([
      "STR",
      ")",
      "/",
      "ID",
    ]);
  });

  test("leaves a comment in an interpolation to divide the value before it", () => {
    expect(shapeOf(template(interpolated("a /* note */ / b")))).toEqual([
      "STR",
      "ID",
      "/",
      "ID",
    ]);
  });
});
