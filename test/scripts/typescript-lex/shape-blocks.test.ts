import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { shapeOf } from "#scripts/typescript-lex.ts";

describe("shapeOf slash decisions after braces", () => {
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

  test("reads label and case braces as blocks", () => {
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

  test("still divides after a brace that holds a ternary arm", () => {
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
  });

  test("still divides after a brace that holds an object property", () => {
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
});
