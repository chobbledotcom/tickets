import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  among,
  and,
  atLeast,
  atMost,
  coalesce,
  count,
  desc,
  equal,
  greaterThan,
  lessThan,
  literal,
  matchesNothing,
  minus,
  not,
  notEqual,
  or,
  orZero,
  plus,
  sum,
  valued,
  when,
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
    expect(text(notEqual(quantity, 2)).sql).toBe("line.quantity != ?");
    expect(text(lessThan(quantity, 2)).sql).toBe("line.quantity < ?");
    expect(text(greaterThan(quantity, 2)).sql).toBe("line.quantity > ?");
    expect(text(atMost(quantity, 2)).sql).toBe("line.quantity <= ?");
    expect(text(atLeast(quantity, 2)).sql).toBe("line.quantity >= ?");
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
    const missing = undefined as unknown as number;
    expect(() => equal(quantity, missing)).toThrow(
      "A value in SQL must be a statement or a value libsql can bind.",
    );
  });

  test("refuse a value of another type and a null for a required column", () => {
    // @ts-expect-error a number column does not compare with text
    equal(quantity, "2");
    // @ts-expect-error a required column holds no null
    equal(quantity, null);
    // @ts-expect-error a number column is not one of these words
    among(quantity, ["2"]);
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

  test("count, add and default", () => {
    expect(count().sql).toBe("COUNT(*)");
    expect(sum(quantity).sql).toBe("SUM(line.quantity)");
    expect(orZero(sum(quantity)).sql).toBe("COALESCE(SUM(line.quantity), 0)");
    expect(text(coalesce(note, "none"))).toEqual({
      args: ["none"],
      sql: "COALESCE(line.note, ?)",
    });
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
