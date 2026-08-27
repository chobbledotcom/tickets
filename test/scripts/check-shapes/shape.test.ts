import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { shapeOf } from "#scripts/check-shapes/shape.ts";

/** A `${…}` group, written so the linter does not read this test's data as a
 * template somebody forgot to tag. */
const interpolated = (code: string): string => `$\{${code}}`;

/** One template literal's source text, from its parts. */
const template = (...parts: string[]): string => `\`${parts.join("")}\``;

describe("shapeOf", () => {
  test("gives two functions that differ only in names one shape", () => {
    expect(shapeOf("(a) => a.trim()")).toEqual(
      shapeOf("(value) => value.trim()"),
    );
  });

  test("gives two functions that differ in structure different shapes", () => {
    expect(shapeOf("(a) => a.trim()")).not.toEqual(
      shapeOf("(a) => a.trim().at(0)"),
    );
  });

  test("reduces a name to ID and keeps the words that carry meaning", () => {
    expect(shapeOf("return total")).toEqual(["return", "ID"]);
  });

  test("reduces every literal to one symbol per kind", () => {
    expect(shapeOf('["a", 12, `x`]')).toEqual([
      "[",
      "STR",
      ",",
      "NUM",
      ",",
      "STR",
      "]",
    ]);
  });

  test("reads a number written any way as one NUM", () => {
    expect(shapeOf("0x1f")).toEqual(["NUM"]);
    expect(shapeOf("1_0")).toEqual(["NUM"]);
    expect(shapeOf("1.5e3")).toEqual(["NUM"]);
  });

  test("keeps a quote that an escape protects inside the string", () => {
    expect(shapeOf('"a\\"b" + c')).toEqual(["STR", "+", "ID"]);
  });

  test("drops a comment, because a comment is not behaviour", () => {
    expect(shapeOf("a // note\n+ b")).toEqual(shapeOf("a + b"));
    expect(shapeOf("a /* note */ + b")).toEqual(shapeOf("a + b"));
  });

  test("drops a comment that runs to the end of the body", () => {
    expect(shapeOf("a // trailing")).toEqual(["ID"]);
    expect(shapeOf("a /* unclosed")).toEqual(["ID"]);
  });

  test("reads every spelling of one number as a single NUM", () => {
    for (const written of [
      "0x1f",
      "0XFF",
      "1_0",
      "1.5e3",
      "1e+3",
      "2E-4",
      "9n",
    ]) {
      expect(shapeOf(written)).toEqual(["NUM"]);
    }
  });

  test("gives two numbers written differently the same shape", () => {
    expect(shapeOf("1e+3")).toEqual(shapeOf("1000"));
    expect(shapeOf("0XFF")).toEqual(shapeOf("255"));
  });

  test("keeps the code inside a template's interpolation", () => {
    expect(shapeOf(template("a ", interpolated("b.c()"), " d"))).toEqual([
      "STR",
      "ID",
      ".",
      "ID",
      "(",
      ")",
    ]);
  });

  test("reads a template with no interpolation as one string", () => {
    expect(shapeOf(template("just text"))).toEqual(["STR"]);
  });

  test("reads every interpolation in one template", () => {
    expect(
      shapeOf(template(interpolated("a"), "-", interpolated("b"))),
    ).toEqual(["STR", "ID", "ID"]);
  });

  test("keeps a brace inside an interpolation from closing it early", () => {
    expect(shapeOf(template(interpolated(" {a: 1} ")))).toEqual([
      "STR",
      "{",
      "ID",
      ":",
      "NUM",
      "}",
    ]);
  });

  test("reads code inside a template nested in an interpolation", () => {
    expect(
      shapeOf(template(interpolated(template(interpolated("a.b()"))))),
    ).toEqual(["STR", "STR", "ID", ".", "ID", "(", ")"]);
  });

  test("leaves a quote inside an interpolation to close itself", () => {
    expect(shapeOf(template(interpolated(' f("}") ')))).toEqual([
      "STR",
      "ID",
      "(",
      "STR",
      ")",
    ]);
  });

  test("gives one shape to two templates that differ only in names", () => {
    expect(shapeOf(template("x ", interpolated("a.map(b)"), " y"))).toEqual(
      shapeOf(template("q ", interpolated("rows.map(fn)"), " z")),
    );
  });

  test("reads an escape inside a template without ending it", () => {
    expect(shapeOf(template("a\\`b ", interpolated("c")))).toEqual([
      "STR",
      "ID",
    ]);
  });

  test("reads an unterminated template without running past the body", () => {
    expect(shapeOf(`\`a ${interpolated("b")}`)).toEqual(["STR", "ID"]);
  });

  test("reads a slash that divides, rather than opening a comment", () => {
    expect(shapeOf("a / b")).toEqual(["ID", "/", "ID"]);
  });

  test("reads a slash at the very end as itself", () => {
    expect(shapeOf("a /")).toEqual(["ID", "/"]);
  });

  test("keeps punctuation as written, so structure still separates", () => {
    expect(shapeOf("a?.b")).toEqual(["ID", "?", ".", "ID"]);
  });

  test("keeps an unterminated string from swallowing the rest twice", () => {
    expect(shapeOf('"a')).toEqual(["STR"]);
  });
});
