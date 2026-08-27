import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import ts from "typescript";
import { isWrite, nodeAt } from "#scripts/unread-fields/writes.ts";

const parse = (code: string): ts.SourceFile =>
  ts.createSourceFile(
    "probe.tsx",
    code,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TSX,
  );

/** Whether the mention of `field` at `nth` puts a value in or takes one out. */
const writesAt = (code: string, field: string, nth = 0): boolean => {
  const source = parse(code);
  let from = -1;
  for (let seen = 0; seen <= nth; seen++) from = code.indexOf(field, from + 1);
  const node = nodeAt(source, from);
  if (!node) throw new Error(`no node at ${from} in ${code}`);
  return isWrite(node);
};

describe("nodeAt", () => {
  test("finds the identifier covering a position", () => {
    const source = parse("const total = 1;");
    expect(
      nodeAt(source, source.getFullText().indexOf("total"))?.getText(),
    ).toBe("total");
  });

  test("finds nothing past the end of the file", () => {
    const source = parse("const total = 1;");
    expect(nodeAt(source, 500)).toBeUndefined();
  });
});

describe("isWrite", () => {
  test("counts the declaration in an interface", () => {
    expect(writesAt("interface Sum { total: number }", "total")).toBe(true);
  });

  test("counts a field declared on a class", () => {
    expect(writesAt("class Sum { total = 1 }", "total")).toBe(true);
  });

  test("counts a field named in an object literal", () => {
    expect(writesAt("const s: Sum = { total: 1 };", "total")).toBe(true);
  });

  test("counts a shorthand field in an object literal", () => {
    expect(writesAt("const s: Sum = { total };", "total")).toBe(true);
  });

  test("counts an assignment onto a field", () => {
    expect(writesAt("s.total = 1;", "total")).toBe(true);
  });

  test("counts a field supplied as a JSX attribute", () => {
    expect(writesAt("const b = <Meter total={1} />;", "total")).toBe(true);
  });

  test("counts a method that fills a field in an object", () => {
    expect(writesAt("const s = { total() { return 1; } };", "total")).toBe(
      true,
    );
  });

  test("counts a method that fills a field on a class", () => {
    expect(writesAt("class S { total() { return 1; } }", "total")).toBe(true);
  });

  test("counts a getter that fills a field", () => {
    expect(writesAt("class S { get total() { return 1; } }", "total")).toBe(
      true,
    );
  });

  test("counts a setter that fills a field", () => {
    expect(writesAt("class S { set total(v: number) {} }", "total")).toBe(true);
  });

  test("counts a method an interface declares", () => {
    expect(writesAt("interface S { total(): number }", "total")).toBe(true);
  });

  test("counts building an object on the right of an assignment", () => {
    expect(writesAt("s = { total: 1 };", "total")).toBe(true);
  });

  test("does not count reading a field", () => {
    expect(writesAt("use(s.total);", "total")).toBe(false);
  });

  test("does not count a field taken out by destructuring", () => {
    expect(writesAt("const { total } = s;", "total")).toBe(false);
  });

  test("does not count a field compared against something", () => {
    expect(writesAt("if (s.total === 1) use(s);", "total")).toBe(false);
  });

  test("does not count the value side of an object literal", () => {
    expect(writesAt("const s = { sum: total };", "total")).toBe(false);
  });

  test("does not count a field taken out by a destructuring assignment", () => {
    expect(writesAt("({ total } = row);", "total")).toBe(false);
  });

  test("does not count a renamed destructuring assignment", () => {
    expect(writesAt("({ total: t } = row);", "total")).toBe(false);
  });

  test("does not count a destructuring assignment with a default", () => {
    expect(writesAt("({ total = 2 } = row);", "total")).toBe(false);
  });

  test("does not count a destructuring assignment nested in a pattern", () => {
    expect(writesAt("({ inner: { total } } = row);", "total")).toBe(false);
  });

  test("does not count a destructuring assignment inside an array pattern", () => {
    expect(writesAt("[{ total }] = rows;", "total")).toBe(false);
  });

  test("does not count a destructuring assignment made by a for loop", () => {
    expect(writesAt("for ({ total } of rows) use(total);", "total")).toBe(
      false,
    );
  });

  test("does not count a bare value given to a field on a class", () => {
    expect(writesAt("class S { sum = total; }", "total")).toBe(false);
  });

  test("does not count a bare default in a shorthand field", () => {
    expect(writesAt("const s = { sum = total };", "total")).toBe(false);
  });

  test("does not count a node with nothing above it", () => {
    expect(isWrite(parse("const total = 1;"))).toBe(false);
  });
});
