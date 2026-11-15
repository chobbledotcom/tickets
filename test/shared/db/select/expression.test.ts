import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  among,
  amongConstants,
  and,
  atLeast,
  atMost,
  desc,
  equal,
  given,
  greaterThan,
  lessThan,
  literal,
  matchesGlob,
  matchesNothing,
  matching,
  minus,
  named,
  not,
  notEqual,
  or,
  orZero,
  plus,
  sum,
  valued,
  when,
  whereTail,
  wholeCondition,
} from "#db/select/expression.ts";
import { sql, sqlName } from "#db/sql.ts";
import { placed } from "#test-utils/sql-text.ts";

const quantity = valued<number>(sqlName("line.quantity"));
const note = valued<string | null>(sqlName("line.note"));

const text = (statement: { args: unknown[]; sql: string }) => placed(statement);

describe("comparisons", () => {
  test("bind the value on the right", () => {
    expect(text(equal(quantity, 2))).toEqual({
      args: [2],
      sql: "line.quantity = ?",
    });
    const operators = [
      [notEqual, "!="],
      [lessThan, "<"],
      [greaterThan, ">"],
      [atMost, "<="],
      [atLeast, ">="],
    ] as const;
    for (const [compare, operator] of operators) {
      expect(text(compare(quantity, 2)).sql).toBe(
        `line.quantity ${operator} ?`,
      );
    }
  });

  test("compare two expressions with no bound value", () => {
    expect(text(equal(quantity, quantity))).toEqual({
      args: [],
      sql: "line.quantity = line.quantity",
    });
  });

  test("ask for a missing value with IS NULL, not with = NULL", () => {
    expect(text(equal(note, null))).toEqual({
      args: [],
      sql: "line.note IS NULL",
    });
    expect(text(notEqual(note, null)).sql).toBe("line.note IS NOT NULL");
  });

  test("refuse an undefined value", () => {
    // @ts-expect-error a comparison needs a value
    expect(() => equal(quantity, undefined)).toThrow(
      "A value in SQL must be a statement or a value libsql can bind.",
    );
  });

  test("refuse a value of another type and a null for a required column", () => {
    // The types refuse each call. The SQL still builds when a cast hides one.
    // @ts-expect-error a number column does not compare with text
    expect(text(equal(quantity, "2")).sql).toBe("line.quantity = ?");
    // @ts-expect-error a required column holds no null
    expect(text(equal(quantity, null)).sql).toBe("line.quantity IS NULL");
    // @ts-expect-error a number column is not one of these words
    expect(text(among(quantity, ["2"])).sql).toBe("line.quantity IN (?)");
  });
});

describe("among", () => {
  test("binds each value of the list", () => {
    expect(text(among(quantity, [1, 2]))).toEqual({
      args: [1, 2],
      sql: "line.quantity IN (?, ?)",
    });
  });

  test("matches nothing for an empty list", () => {
    const none = among(quantity, []);
    expect(none.sql).toBe("line.quantity IN (NULL)");
    expect(matchesNothing(none)).toBe(true);
    expect(matchesNothing(among(quantity, [1]))).toBe(false);
  });
});

describe("and, or, not", () => {
  const big = greaterThan(quantity, 5);
  const small = lessThan(quantity, 2);

  test("join whole conditions without brackets", () => {
    expect(and(big, small).sql).toBe(
      "line.quantity > ?1 AND line.quantity < ?2",
    );
  });

  test("bracket an OR inside an AND, and an AND inside an OR", () => {
    expect(and(or(big, small), big).sql).toBe(
      "(line.quantity > ?1 OR line.quantity < ?2) AND line.quantity > ?1",
    );
    expect(or(and(big, small), big).sql).toBe(
      "((line.quantity > ?1 AND line.quantity < ?2) OR line.quantity > ?1)",
    );
  });

  test("bracket hand-written SQL that an operator can split", () => {
    const loose = valued<boolean>(sql`a = 1 OR b = 2`);
    expect(and(loose, big).sql).toBe("(a = 1 OR b = 2) AND line.quantity > ?1");
    expect(not(loose).sql).toBe("NOT (a = 1 OR b = 2)");
    expect(and(wholeCondition(sql`a IS NULL`), big).sql).toBe(
      "a IS NULL AND line.quantity > ?1",
    );
  });

  test("leave out a condition that is already true", () => {
    expect(and(true, big).sql).toBe("line.quantity > ?1");
    expect(and().sql).toBe("1");
    expect(and(true).sql).toBe("1");
    expect(or(false, big).sql).toBe("(line.quantity > ?1)");
  });

  test("know when no row can pass", () => {
    const none = among(quantity, []);
    expect(matchesNothing(and(big, none))).toBe(true);
    expect(matchesNothing(and(big, false))).toBe(true);
    expect(and(big, false).sql).toBe("line.quantity > ?1 AND 0");
    expect(matchesNothing(or(big, none))).toBe(false);
    expect(matchesNothing(or(none, false))).toBe(true);
    expect(matchesNothing(or())).toBe(true);
    expect(or().sql).toBe("0");
    expect(matchesNothing(and(big, small))).toBe(false);
    expect(matchesNothing(true)).toBe(false);
    expect(matchesNothing(false)).toBe(true);
  });

  test("negate a whole condition without brackets", () => {
    expect(not(big).sql).toBe("NOT line.quantity > ?1");
    expect(not(false).sql).toBe("NOT 0");
  });
});

describe("worked-out values", () => {
  test("write a constant into the text", () => {
    expect(text(equal(quantity, literal(1)))).toEqual({
      args: [],
      sql: "line.quantity = 1",
    });
    expect(literal("it's").sql).toBe("'it''s'");
  });

  test("add and default", () => {
    expect(sum(quantity).sql).toBe("SUM(line.quantity)");
    expect(orZero(sum(quantity)).sql).toBe("COALESCE(SUM(line.quantity), 0)");
  });

  test("bracket arithmetic so a later operator cannot regroup it", () => {
    expect(text(minus(quantity, plus(quantity, 1)))).toEqual({
      args: [1],
      sql: "(line.quantity - (line.quantity + ?))",
    });
  });

  test("choose the value of the first branch that holds", () => {
    expect(
      text(
        when<string>(
          [
            [greaterThan(quantity, 5), "big"],
            [true, "some"],
          ],
          "none",
        ),
      ),
    ).toEqual({
      args: [5, "big", "some", "none"],
      sql: "CASE WHEN line.quantity > ? THEN ? WHEN 1 THEN ? ELSE ? END",
    });
  });

  test("order largest first", () => {
    expect(desc(quantity).sql).toBe("line.quantity DESC");
  });
});

describe("a list of a column that can hold nothing", () => {
  test("takes the values without the null", () => {
    expect(text(among(note, ["a", "b"]))).toEqual({
      args: ["a", "b"],
      sql: "line.note IN (?, ?)",
    });
  });
});

describe("amongConstants", () => {
  test("writes each constant into the text", () => {
    expect(text(amongConstants(note, ["a", "it's"]))).toEqual({
      args: [],
      sql: "line.note IN ('a', 'it''s')",
    });
  });
});

describe("matchesGlob", () => {
  test("writes the pattern into the text", () => {
    expect(text(matchesGlob(note, "refund_*"))).toEqual({
      args: [],
      sql: "line.note GLOB 'refund_*'",
    });
  });

  test("is one condition that NOT takes without brackets", () => {
    expect(not(matchesGlob(note, "a*")).sql).toBe("NOT line.note GLOB 'a*'");
  });
});

describe("one condition alone", () => {
  test("joins as itself, so NOT takes it without brackets", () => {
    expect(text(not(and(equal(quantity, 1)))).sql).toBe(
      "NOT line.quantity = ?",
    );
  });
});

describe("an AND inside an AND", () => {
  const some = equal(quantity, 1);
  const more = greaterThan(quantity, 2);
  const most = lessThan(quantity, 3);

  test("reads as one list with no brackets", () => {
    expect(and(and(some, more), most).sql).toBe(
      "line.quantity = ?1 AND line.quantity > ?2 AND line.quantity < ?3",
    );
  });

  test("keeps the brackets of an AND inside an OR", () => {
    expect(or(and(some, more), most).sql).toBe(
      "((line.quantity = ?1 AND line.quantity > ?2) OR line.quantity < ?3)",
    );
  });

  test("still knows when no row can pass", () => {
    expect(matchesNothing(and(and(some, among(quantity, [])), most))).toBe(
      true,
    );
  });
});

describe("named", () => {
  test("names a column by text", () => {
    expect(text(equal(named("thing.id"), 7))).toEqual({
      args: [7],
      sql: "thing.id = ?",
    });
  });

  test("refuses text that is not a name", () => {
    expect(() => named("id; --")).toThrow('Not a valid SQL name: "id; --"');
  });
});

describe("given", () => {
  test("keeps every row where the caller gave no value", () => {
    expect(given(undefined, () => false)).toBe(true);
  });

  test("tests a value that the caller gave, a falsy value too", () => {
    expect(given(0, (value) => equal(quantity, value))).toEqual(
      equal(quantity, 0),
    );
  });
});

describe("whereTail", () => {
  test("is empty when no condition narrows the rows", () => {
    expect(whereTail([])).toEqual(sql``);
    expect(whereTail([true, true])).toEqual(sql``);
  });

  test("joins the conditions with AND, in order, with their values", () => {
    expect(whereTail([equal(quantity, 1), true, among(note, ["x"])])).toEqual(
      sql` WHERE line.quantity = ${1} AND line.note IN (${"x"})`,
    );
  });

  test("says in SQL that no row can pass", () => {
    expect(whereTail([false]).sql).toBe(" WHERE 0");
  });
});

describe("matching", () => {
  test("asks each named column for its value, in the order of the match", () => {
    expect(matching(named, { id: 4, name: "x" })).toEqual([
      equal(named("id"), 4),
      equal(named("name"), "x"),
    ]);
  });

  test("reads a list as one of these values", () => {
    expect(matching(named, { id: [1, 2] })).toEqual([
      among(named("id"), [1, 2]),
    ]);
  });

  test("reads a null as a column that holds nothing", () => {
    expect(matching(named, { note: null })[0]?.sql).toBe("note IS NULL");
  });

  test("gives a condition that no row can pass for an empty list", () => {
    expect(matching(named, { id: [] }).map(matchesNothing)).toEqual([true]);
  });

  test("gives no condition for an empty match", () => {
    expect(matching(named, {})).toEqual([]);
  });
});
