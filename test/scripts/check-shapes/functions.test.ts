import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { maskedRuns, namedFunctions } from "#scripts/check-shapes/functions.ts";
import { parseProgram } from "#scripts/parse-program.ts";

const found = (source: string) =>
  namedFunctions(parseProgram("sample.ts", source), source);

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

  test("names a handler keyed by a route string", () => {
    expect(names('const routes = { "GET /health": (a) => a + 1 };')).toEqual([
      "routes.GET /health",
    ]);
  });

  test("names a handler keyed by a number", () => {
    expect(names("const pages = { 404: (a) => a + 1 };")).toEqual([
      "pages.404",
    ]);
  });

  test("names a handler assigned under a route string", () => {
    expect(names('routes["GET /health"] = (a) => a + 1;')).toEqual([
      "GET /health",
    ]);
  });

  test("names the function a conditional selects", () => {
    expect(
      names("const verifyName = pick ? (row) => { work(row); } : undefined"),
    ).toEqual(["verifyName"]);
  });

  test("names through the wrappers that only restate a type or group", () => {
    expect(
      names("const save = ((row) => { work(row); }) satisfies Handler;"),
    ).toEqual(["save"]);
    expect(names("const load = ((row) => { work(row); }) as Handler;")).toEqual(
      ["load"],
    );
    expect(names("const run = ((row) => { work(row); });")).toEqual(["run"]);
    expect(names("const make = <Handler>((row) => { work(row); });")).toEqual([
      "make",
    ]);
  });

  test("leaves an assignment with no name anywhere alone", () => {
    expect(names("handlers[pick()] = (a) => a + 1;")).toEqual([]);
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

/** What each masked run covers and what stands for it, so a test reads text
 *  rather than offsets. */
const masked = (source: string): [string, string][] =>
  maskedRuns(parseProgram("sample.tsx", source), source).map((run) => [
    source.slice(run.start, run.end),
    run.as,
  ]);

describe("maskedRuns", () => {
  test("masks every name somebody chose", () => {
    expect(masked("const total = (rows) => rows.length;")).toEqual([
      ["total", "_"],
      ["rows", "_"],
      ["rows", "_"],
      ["length", "_"],
    ]);
  });

  test("masks a keyword used as a name, so it reads as a name", () => {
    expect(masked("const f = (type) => type;")).toContainEqual(["type", "_"]);
  });

  test("masks the words a component renders as one string", () => {
    expect(masked("const A = () => <b>Save changes</b>;")).toContainEqual([
      "Save changes",
      '""',
    ]);
  });

  test("drops whitespace between elements, so wrapping cannot change a shape", () => {
    const runs = masked("const A = () => (\n  <p>\n    <b/>\n  </p>\n);");
    expect(runs.filter(([, as]) => as === "")).not.toEqual([]);
  });

  test("masks a closing tag without repeating the element name", () => {
    expect(masked("const A = () => <b>x</b>;")).toContainEqual(["</b>", "<>"]);
  });

  test("masks a closing fragment, so its slash cannot open a pattern", () => {
    expect(masked("const A = () => <>x</>;")).toContainEqual(["</>", "<>"]);
  });

  test("leaves an interpolated value as code, masking only its names", () => {
    const runs = masked("const A = ({ n }) => <b>{n.toFixed(2)}</b>;");
    expect(runs.every(([, as]) => as !== '""')).toBe(true);
  });
});
