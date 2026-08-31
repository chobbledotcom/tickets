import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { namesAMember } from "#scripts/unread-fields/writes.ts";
import { namesAMemberAt, parse } from "./helpers.ts";

describe("namesAMember", () => {
  test("a mention after a dot names a member", () => {
    expect(namesAMemberAt("use(row.total);", "total")).toBe(true);
  });

  test("a mention inside brackets names a member", () => {
    expect(namesAMemberAt('use(row["total"]);', "total")).toBe(true);
  });

  test("a variable used as a computed key names no member", () => {
    expect(namesAMemberAt("use(row[total]);", "total")).toBe(false);
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

  test("the name an assignment pattern reaches names a member", () => {
    expect(namesAMemberAt("({ total } = row);", "total")).toBe(true);
  });

  test("the name a renaming assignment pattern reaches names a member", () => {
    expect(namesAMemberAt("({ total: held } = row);", "total")).toBe(true);
  });

  test("the slot a renaming assignment pattern fills names no member", () => {
    // `held` is the variable the value lands in, not a member of anything.
    expect(namesAMemberAt("({ total: held } = row);", "held")).toBe(false);
  });

  test("a field named in a plain object literal names no member", () => {
    // `{ total: 1 }` is built from the same nodes as an assignment pattern,
    // and the literal around it is a value rather than a pattern.
    expect(namesAMemberAt("const s = { total: 1 };", "total")).toBe(false);
  });

  test("a name standing on its own names no member", () => {
    expect(namesAMemberAt("const total = 1;", "total")).toBe(false);
  });

  test("the name a pattern reaches through brackets names a member", () => {
    expect(namesAMemberAt('({ ["total"]: held } = row);', "total")).toBe(true);
  });

  test("a name with nothing above it names no member", () => {
    expect(namesAMember(parse("const total = 1;"))).toBe(false);
  });
});
