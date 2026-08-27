import { parseSync } from "npm:oxc-parser@0.132.0";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  jsxTextSpans,
  namedFunctions,
} from "#scripts/check-shapes/functions.ts";

const found = (source: string) =>
  namedFunctions(parseSync("sample.ts", source).program, source);

const names = (source: string) => found(source).map((entry) => entry.name);

describe("namedFunctions", () => {
  test("names a function declared with the function keyword", () => {
    expect(names("function total(a) { return a; }")).toEqual(["total"]);
  });

  test("names an arrow by the variable it is assigned to", () => {
    expect(names("const total = (a) => a + 1;")).toEqual(["total"]);
  });

  test("names an exported arrow", () => {
    expect(names("export const total = (a) => a + 1;")).toEqual(["total"]);
  });

  test("names a curried factory once, by its outer name", () => {
    expect(names("const at = (a) => (b) => a + b;")).toEqual(["at"]);
  });

  test("leaves an inline callback alone, having nothing to call it", () => {
    expect(names("run(() => 1);")).toEqual([]);
  });

  test("takes the body of an arrow with no braces", () => {
    const [entry] = found("const total = (a) => a + 1;");
    expect(entry?.start).toBeLessThan(entry?.end as number);
  });

  test("reports the line the body starts on", () => {
    const [entry] = found("\n\nconst total = (a) => a + 1;");
    expect(entry?.line).toBe(3);
  });

  test("finds every named function in the file", () => {
    expect(names("const a = () => 1;\nfunction b() { return 2; }")).toEqual([
      "a",
      "b",
    ]);
  });

  test("names an arrow held by an object property", () => {
    expect(names("const handlers = { save: (a) => a + 1 };")).toEqual([
      "handlers.save",
    ]);
  });

  test("names an object method", () => {
    expect(names("const handlers = { save(a) { return a; } };")).toEqual([
      "handlers.save",
    ]);
  });

  test("names a class method", () => {
    expect(names("class A { save(a) { return a; } }")).toEqual(["A.save"]);
  });

  test("names a class field holding an arrow", () => {
    expect(names("class A { save = (a) => a; }")).toEqual(["A.save"]);
  });

  test("names a function expression by its own name as well as the variable's", () => {
    expect(names("const outer = function inner() { return 1; };")).toEqual([
      "outer.inner",
    ]);
  });
});

describe("namedFunctions naming what a function sits inside", () => {
  test("names a method by its object as well as itself", () => {
    expect(names("const handlers = { save() { return 1; } };")).toEqual([
      "handlers.save",
    ]);
  });

  test("tells two methods of the same name in one file apart", () => {
    expect(
      names("const a = { save: () => 1 }; const b = { save: () => 2 };"),
    ).toEqual(["a.save", "b.save"]);
  });

  test("names a class method by its class", () => {
    expect(names("class Ledger { post(a) { return a; } }")).toEqual([
      "Ledger.post",
    ]);
  });
});

/** The text each JSX run covers, so a test reads words rather than offsets. */
const jsxText = (source: string): string[] =>
  jsxTextSpans(parseSync("sample.tsx", source).program).map((span) =>
    source.slice(span.start, span.end),
  );

describe("jsxTextSpans", () => {
  test("finds the words a component renders", () => {
    expect(jsxText("const A = () => <b>Save changes</b>;")).toEqual([
      "Save changes",
    ]);
  });

  test("finds the runs on both sides of a nested element", () => {
    expect(jsxText("const A = () => <p>Hi <b>you</b> there</p>;")).toEqual([
      "Hi ",
      "you",
      " there",
    ]);
  });

  test("finds nothing in a file with no JSX", () => {
    expect(jsxText("const add = (a: number) => a + 1;")).toEqual([]);
  });

  test("leaves an interpolated value alone, because it is code", () => {
    expect(jsxText("const A = ({ n }) => <b>{n.toFixed(2)}</b>;")).toEqual([]);
  });
});
