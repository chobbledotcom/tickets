import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import ts from "typescript";
import {
  type AskAboutAMention,
  namesAMember,
  nodeAt,
  readsTheValue,
} from "#scripts/unread-fields/writes.ts";

const parse = (code: string): ts.SourceFile =>
  ts.createSourceFile(
    "probe.tsx",
    code,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TSX,
  );

/** Put a question to the mention of `field` at `nth` in a scrap of code. */
const askAt =
  (ask: AskAboutAMention) =>
  (code: string, field: string, nth = 0): boolean => {
    const source = parse(code);
    let from = -1;
    for (let seen = 0; seen <= nth; seen++) {
      from = code.indexOf(field, from + 1);
    }
    const node = nodeAt(source, from);
    if (!node) throw new Error(`no node at ${from} in ${code}`);
    return ask(node);
  };

/** Whether that mention takes the value out of the field. */
const readsAt = askAt(readsTheValue);

/** Whether that mention names a member of something. */
const namesAMemberAt = askAt(namesAMember);

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
    // `for (row.total in source)` puts a key in without looking at the old
    // value, exactly as the for-of form does.
    expect(readsAt("for (row.total in source) use(row);", "total")).toBe(false);
  });

  test("does not read a field a delete takes away", () => {
    expect(readsAt("delete row.total;", "total")).toBe(false);
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
});

describe("namesAMember", () => {
  test("a mention after a dot names a member", () => {
    expect(namesAMemberAt("use(row.total);", "total")).toBe(true);
  });

  test("a mention inside brackets names a member", () => {
    expect(namesAMemberAt('use(row["total"]);', "total")).toBe(true);
  });

  test("the name a pattern takes out names a member", () => {
    expect(namesAMemberAt("const { total } = row;", "total")).toBe(true);
  });

  test("the name a renaming pattern reaches names a member", () => {
    expect(namesAMemberAt("const { total: sum } = row;", "total")).toBe(true);
  });

  test("the name a renaming pattern binds names a member", () => {
    // `sum` is the slot the pattern fills, and it sits on a binding element
    // like the reached name does.
    expect(namesAMemberAt("const { total: sum } = row;", "sum")).toBe(true);
  });

  test("a name standing on its own names no member", () => {
    expect(namesAMemberAt("const total = 1;", "total")).toBe(false);
  });

  test("a name with nothing above it names no member", () => {
    expect(namesAMember(parse("const total = 1;"))).toBe(false);
  });
});
