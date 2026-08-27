import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { shapeOf } from "#scripts/check-shapes/shape.ts";

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

  test("keeps punctuation as written, so structure still separates", () => {
    expect(shapeOf("a?.b")).toEqual(["ID", "?", ".", "ID"]);
  });

  test("keeps an unterminated string from swallowing the rest twice", () => {
    expect(shapeOf('"a')).toEqual(["STR"]);
  });
});
