import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { shapeOf } from "#scripts/typescript-lex.ts";
import { interpolated, template } from "#test/scripts/check-shapes/samples.ts";

describe("shapeOf slash decisions inside template interpolations", () => {
  test("keeps a pattern whole after a header", () => {
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

  test("keeps a pattern whole after return", () => {
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

  test("keeps a pattern brace from closing the interpolation", () => {
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

  test("reads a step operator before division", () => {
    expect(shapeOf(template(interpolated("i++ / n")))).toEqual([
      "STR",
      "ID",
      "++",
      "/",
      "ID",
    ]);
  });

  test("still divides after a value", () => {
    expect(shapeOf(template(interpolated("a / b")))).toEqual([
      "STR",
      "ID",
      "/",
      "ID",
    ]);
    expect(shapeOf(template(interpolated("total! / divisor")))).toEqual([
      "STR",
      "ID",
      "!",
      "/",
      "ID",
    ]);
    expect(shapeOf(template(interpolated("! /}/.test(value)")))).toEqual([
      "STR",
      "!",
      "RE",
      ".",
      "ID",
      "(",
      "ID",
      ")",
    ]);
    expect(shapeOf(template(interpolated(" ) / width ")))).toEqual([
      "STR",
      ")",
      "/",
      "ID",
    ]);
  });

  test("leaves a comment before division", () => {
    expect(shapeOf(template(interpolated("a /* note */ / b")))).toEqual([
      "STR",
      "ID",
      "/",
      "ID",
    ]);
  });

  test("reads a leading object as a value inside an interpolation", () => {
    expect(shapeOf(template(interpolated("{} / 2")))).toEqual([
      "STR",
      "{",
      "}",
      "/",
      "NUM",
    ]);
  });
});
