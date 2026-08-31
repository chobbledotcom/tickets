import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { readsTheValue } from "#scripts/unread-fields/writes.ts";
import { parse, readsAt, readsInPlainTsAt } from "./helpers.ts";

describe("readsTheValue", () => {
  test("does not read the declaration in an interface", () => {
    expect(readsAt("interface Sum { total: number }", "total")).toBe(false);
  });

  test("does not read a field declared on a class", () => {
    expect(readsAt("class Sum { total = 1 }", "total")).toBe(false);
  });

  test("does not read a field named in an object literal", () => {
    expect(readsAt("const s: Sum = { total: 1 };", "total")).toBe(false);
  });

  test("does not read a shorthand field in an object literal", () => {
    expect(readsAt("const s: Sum = { total };", "total")).toBe(false);
  });

  test("does not read an assignment onto a field", () => {
    expect(readsAt("s.total = 1;", "total")).toBe(false);
  });

  test("does not read an assignment through a fixed key in brackets", () => {
    expect(readsAt('row["total"] = 1;', "total")).toBe(false);
  });

  test("does not read the slot a destructuring pattern fills", () => {
    expect(readsAt("({ value: row.total } = source);", "total")).toBe(false);
  });

  test("does not read the slot an array pattern fills", () => {
    expect(readsAt("[row.total] = pair;", "total")).toBe(false);
  });

  test("does not read a field supplied as a JSX attribute", () => {
    expect(readsAt("const b = <Meter total={1} />;", "total")).toBe(false);
  });

  test("does not read a method that fills a field in an object", () => {
    expect(readsAt("const s = { total() { return 1; } };", "total")).toBe(
      false,
    );
  });

  test("does not read a method that fills a field on a class", () => {
    expect(readsAt("class S { total() { return 1; } }", "total")).toBe(false);
  });

  test("does not read a getter that fills a field", () => {
    expect(readsAt("class S { get total() { return 1; } }", "total")).toBe(
      false,
    );
  });

  test("does not read a setter that fills a field", () => {
    expect(readsAt("class S { set total(v: number) {} }", "total")).toBe(false);
  });

  test("does not read a method an interface declares", () => {
    expect(readsAt("interface S { total(): number }", "total")).toBe(false);
  });

  test("does not read building an object on the right of an assignment", () => {
    expect(readsAt("s = { total: 1 };", "total")).toBe(false);
  });

  test("reads reading a field", () => {
    expect(readsAt("use(s.total);", "total")).toBe(true);
  });

  test("reads a field taken out by destructuring", () => {
    expect(readsAt("const { total } = s;", "total")).toBe(true);
  });

  test("reads a read through a fixed key in brackets", () => {
    expect(readsAt('use(row["total"]);', "total")).toBe(true);
  });

  test("reads a field compared against something", () => {
    expect(readsAt("if (s.total === 1) use(s);", "total")).toBe(true);
  });

  test("reads the value side of an object literal", () => {
    expect(readsAt("const s = { sum: total };", "total")).toBe(true);
  });

  test("reads a field taken out by a destructuring assignment", () => {
    expect(readsAt("({ total } = row);", "total")).toBe(true);
  });

  test("reads a renamed destructuring assignment", () => {
    expect(readsAt("({ total: t } = row);", "total")).toBe(true);
  });

  test("reads a destructuring assignment with a default", () => {
    expect(readsAt("({ total = 2 } = row);", "total")).toBe(true);
  });

  test("reads a destructuring assignment nested in a pattern", () => {
    expect(readsAt("({ inner: { total } } = row);", "total")).toBe(true);
  });

  test("reads a destructuring assignment inside an array pattern", () => {
    expect(readsAt("[{ total }] = rows;", "total")).toBe(true);
  });

  test("reads a destructuring assignment made by a for loop", () => {
    expect(readsAt("for ({ total } of rows) use(total);", "total")).toBe(true);
  });

  test("reads a bare value given to a field on a class", () => {
    expect(readsAt("class S { sum = total; }", "total")).toBe(true);
  });

  test("reads a bare default in a shorthand field", () => {
    expect(readsAt("const s = { sum = total };", "total")).toBe(true);
  });

  test("does not read a field a for-in loop assigns each key to", () => {
    // `for (row.total in source)` puts a key in with no read of the old value,
    // exactly as the for-of form does.
    expect(readsAt("for (row.total in source) use(row);", "total")).toBe(false);
  });

  test("does not read a field a delete takes away", () => {
    expect(readsAt("delete row.total;", "total")).toBe(false);
  });

  test("does not read a field a delete takes away through parentheses", () => {
    expect(readsAt("delete (row.total);", "total")).toBe(false);
  });

  test("does not read a field a delete takes away through brackets", () => {
    expect(readsAt('delete row["total"];', "total")).toBe(false);
  });

  test("does not read a field named only to borrow its type", () => {
    // `Config["total"]` reuses the type. Nothing moves when the program runs.
    expect(readsAt('type T = Config["total"];', "total")).toBe(false);
  });

  test("still reads a field named in a value beside a type", () => {
    expect(readsAt("const t: Config = row.total;", "total")).toBe(true);
  });

  test("does not read a field an array rest fills", () => {
    // `[...row.total] = source` puts a value in without a look at the old one.
    expect(readsAt("[...row.total] = source;", "total")).toBe(false);
  });

  test("does not read a field an object rest fills", () => {
    expect(readsAt("({ ...row.total } = source);", "total")).toBe(false);
  });

  test("still reads a field a spread copies into a new object", () => {
    expect(readsAt("const copy = { ...row.total };", "total")).toBe(true);
  });

  test("still reads a field a spread hands to a call", () => {
    expect(readsAt("use([...row.total]);", "total")).toBe(true);
  });

  test("does not read a field filled behind a non-null assertion", () => {
    expect(readsAt("row.total! = 1;", "total")).toBe(false);
  });

  test("does not read a field filled behind a cast", () => {
    expect(readsAt("(row.total as number) = 1;", "total")).toBe(false);
  });

  test("does not read a field filled behind a satisfies", () => {
    expect(readsAt("(row.total satisfies number) = 1;", "total")).toBe(false);
  });

  test("does not read a field filled behind an angle-bracket assertion", () => {
    // `(<number>row.total) = 1` needs its parentheses to parse at all, and
    // the assertion inside them changes nothing when the program runs.
    expect(readsInPlainTsAt("(<number>row.total) = 1;", "total")).toBe(false);
  });

  test("does not read a field an ambient class only describes", () => {
    // A declared class describes one that exists somewhere else. Nothing
    // builds it, so nothing ever looks the field up.
    expect(readsAt("declare class Child extends r.total {}", "total")).toBe(
      false,
    );
  });

  test("does not read a field a class in a declared namespace describes", () => {
    expect(
      readsAt("declare namespace N { class C extends r.total {} }", "total"),
    ).toBe(false);
  });

  test("does not read a field a for-of loop fills behind a bang", () => {
    expect(readsAt("for (row.total! of rows) use(row);", "total")).toBe(false);
  });

  test("does not read a field a name in brackets supplies", () => {
    expect(readsAt('const s: Sum = { ["total"]: 1 };', "total")).toBe(false);
  });

  test("does not read a field a name in brackets declares on a class", () => {
    expect(readsAt('class S { ["total"] = 1; }', "total")).toBe(false);
  });

  test("reads a field a pattern takes out through brackets", () => {
    expect(readsAt('({ ["total"]: held } = row);', "total")).toBe(true);
  });

  test("reads a field a pattern works its key out from", () => {
    // `[row.total]` is a value the brackets read, not a name they hold.
    expect(readsAt("({ [row.total]: held } = source);", "total")).toBe(true);
  });

  test("still reads a field a non-null assertion hands to a call", () => {
    expect(readsAt("use(row.total!);", "total")).toBe(true);
  });

  test("reads a field a class is built on", () => {
    // The clause counts as a type, but the program reads the field to find
    // the class to build on.
    expect(readsAt("class Child extends r.total {}", "total")).toBe(true);
  });

  test("does not read a field an interface only extends", () => {
    expect(readsAt("interface Child extends R.total {}", "total")).toBe(false);
  });

  test("reads a node with nothing above it", () => {
    expect(readsTheValue(parse("const total = 1;"))).toBe(true);
  });

  test("does not read a field an interface's brackets name", () => {
    // The compiler works the name out while it checks the file, and nothing
    // evaluates it when the program runs.
    expect(readsAt("interface Uses { [Registry.key]: string }", "key")).toBe(
      false,
    );
  });

  test("does not read a field a described class's brackets name", () => {
    expect(
      readsAt("declare class Held { [Registry.key]: string }", "key"),
    ).toBe(false);
  });

  test("reads a field a real class's brackets name", () => {
    // A class the program builds works its member names out as it runs.
    expect(readsAt('class Runs { [Registry.key] = "x" }', "key")).toBe(true);
  });

  test("does not read a field an abstract member's brackets name", () => {
    // The compiler erases an abstract member, so the class it sits in is
    // built with nothing that could work the name out.
    expect(
      readsAt("abstract class Plan { abstract [Registry.key](): void }", "key"),
    ).toBe(false);
  });
});
