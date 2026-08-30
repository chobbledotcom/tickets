import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import ts from "typescript";
import { isWrite, nodeAt } from "#scripts/unread-fields/writes.ts";

const parse = (code: string): ts.SourceFile =>
  ts.createSourceFile("probe.ts", code, ts.ScriptTarget.ESNext, true);

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

  test("does not count a node with nothing above it", () => {
    expect(isWrite(parse("const total = 1;"))).toBe(false);
  });
});
