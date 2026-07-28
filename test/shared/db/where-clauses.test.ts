/**
 * Unit tests for the shared filter-clause helpers
 * (`src/shared/db/where-clauses.ts`). They are pure string and array builders —
 * no DB — so they are tested directly. Both declarative readers are built on
 * them, so a mutant that loses a clause, drops an argument, or joins the
 * clauses with the wrong keyword breaks every declared read at once.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  clauseArgs,
  equals,
  inList,
  matchesNoRows,
  orderSql,
  whereSql,
} from "#shared/db/where-clauses.ts";

describe("inList", () => {
  test("adds no clause when the caller did not ask for this filter", () => {
    expect(inList("thing.id", undefined)).toEqual([]);
  });

  test("binds one placeholder per value", () => {
    expect(inList("thing.id", [4, 5, 6])).toEqual([
      { args: [4, 5, 6], clause: "thing.id IN (?, ?, ?)" },
    ]);
  });

  test("copies the values rather than holding the caller's array", () => {
    const ids = [1, 2];
    const [part] = inList("thing.id", ids);
    ids.push(3);
    expect(part?.args).toEqual([1, 2]);
  });

  test("an empty set becomes a clause no row can pass", () => {
    expect(inList("thing.id", [])).toEqual([
      { args: [], clause: "thing.id IN (NULL)", matchesNothing: true },
    ]);
  });
});

describe("equals", () => {
  test("matches a column against a value", () => {
    expect(equals("thing.id", 7)).toEqual([
      { args: [7], clause: "thing.id = ?" },
    ]);
  });

  test("adds no clause when there is nothing to match on", () => {
    expect(equals("thing.id", undefined)).toEqual([]);
    expect(equals("thing.id", null)).toEqual([]);
  });

  test("matches falsy values rather than treating them as absent", () => {
    expect(equals("thing.active", 0)).toEqual([
      { args: [0], clause: "thing.active = ?" },
    ]);
    expect(equals("thing.name", "")).toEqual([
      { args: [""], clause: "thing.name = ?" },
    ]);
  });
});

describe("matchesNoRows", () => {
  test("is true when any clause can never match", () => {
    expect(matchesNoRows([...inList("a.id", [1]), ...inList("b.id", [])])).toBe(
      true,
    );
  });

  test("is false when every clause can match", () => {
    expect(matchesNoRows(inList("a.id", [1]))).toBe(false);
  });

  test("is false with no clauses at all", () => {
    expect(matchesNoRows([])).toBe(false);
  });
});

describe("whereSql", () => {
  test("is empty when there are no clauses", () => {
    expect(whereSql([])).toBe("");
  });

  test("joins every clause with AND, in order", () => {
    expect(
      whereSql([
        { args: [], clause: "a = 1" },
        { args: [], clause: "b = 2" },
        { args: [], clause: "c = 3" },
      ]),
    ).toBe(" WHERE a = 1 AND b = 2 AND c = 3");
  });
});

describe("clauseArgs", () => {
  test("collects every clause's arguments in clause order", () => {
    expect(
      clauseArgs([
        { args: [1, 2], clause: "a IN (?, ?)" },
        { args: [], clause: "b = 1" },
        { args: ["x"], clause: "c = ?" },
      ]),
    ).toEqual([1, 2, "x"]);
  });

  test("is empty with no clauses", () => {
    expect(clauseArgs([])).toEqual([]);
  });
});

describe("orderSql", () => {
  const ORDERS = { newest: "created DESC", oldest: "created ASC" };

  test("is empty when the caller does not care about order", () => {
    expect(orderSql(ORDERS, undefined)).toBe("");
  });

  test("names the SQL for the chosen order", () => {
    expect(orderSql(ORDERS, "newest")).toBe(" ORDER BY created DESC");
    expect(orderSql(ORDERS, "oldest")).toBe(" ORDER BY created ASC");
  });
});
