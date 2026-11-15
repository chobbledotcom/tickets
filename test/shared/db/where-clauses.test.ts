/**
 * Unit tests for the shared filter-clause helpers
 * (`src/shared/db/where-clauses.ts`). They are pure string and array builders —
 * no DB — so they are tested directly. Both declarative readers are built on
 * them, so a mutant that loses a clause, drops an argument, or joins the
 * clauses with the wrong keyword breaks every declared read at once.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { sql } from "#db/sql.ts";
import {
  equals,
  inList,
  rowsUnlessNoneMatch,
  whereSql,
} from "#db/where-clauses.ts";

describe("inList", () => {
  test("adds no clause when the caller did not ask for this filter", () => {
    expect(inList("thing.id", undefined)).toEqual([]);
  });

  test("binds one placeholder per value", () => {
    expect(inList("thing.id", [4, 5, 6])).toEqual([
      { clause: sql`thing.id IN (${4}, ${5}, ${6})` },
    ]);
  });

  test("copies the values rather than holding the caller's array", () => {
    const ids = [1, 2];
    const [part] = inList("thing.id", ids);
    ids.push(3);
    expect(part?.clause.args).toEqual([1, 2]);
  });

  test("an empty set becomes a clause no row can pass", () => {
    expect(inList("thing.id", [])).toEqual([
      { clause: sql`thing.id IN (NULL)`, matchesNothing: true },
    ]);
  });
});

describe("equals", () => {
  test("matches a column against a value", () => {
    expect(equals("thing.id", 7)).toEqual([{ clause: sql`thing.id = ${7}` }]);
  });

  test("adds no clause when there is nothing to match on", () => {
    expect(equals("thing.id", undefined)).toEqual([]);
  });

  test("refuses to match against NULL rather than widening the read", () => {
    // The type rules this out; the guard catches a caller who gets past it.
    expect(() =>
      equals("thing.deleted_at", null as unknown as undefined),
    ).toThrow("Cannot filter thing.deleted_at against NULL");
  });

  test("matches falsy values rather than treating them as absent", () => {
    expect(equals("thing.active", 0)).toEqual([
      { clause: sql`thing.active = ${0}` },
    ]);
    expect(equals("thing.name", "")).toEqual([
      { clause: sql`thing.name = ${""}` },
    ]);
  });
});

describe("rowsUnlessNoneMatch", () => {
  test("runs the read when the clauses can match", async () => {
    expect(
      await rowsUnlessNoneMatch(inList("a.id", [1]), () =>
        Promise.resolve([7]),
      ),
    ).toEqual([7]);
  });

  test("answers without running the read when they cannot", async () => {
    let ran = false;
    const rows = await rowsUnlessNoneMatch(inList("a.id", []), () => {
      ran = true;
      return Promise.resolve([7]);
    });
    expect(rows).toEqual([]);
    expect(ran).toBe(false);
  });
});

describe("whereSql", () => {
  test("is empty when there are no clauses", () => {
    expect(whereSql([])).toEqual(sql``);
  });

  test("joins every clause with AND, in order", () => {
    expect(
      whereSql([
        { clause: sql`a = 1` },
        { clause: sql`b = 2` },
        { clause: sql`c = 3` },
      ]),
    ).toEqual(sql` WHERE a = 1 AND b = 2 AND c = 3`);
  });
});

describe("whereSql values", () => {
  test("keeps every clause's values in clause order", () => {
    expect(
      whereSql([
        { clause: sql`a IN (${1}, ${2})` },
        { clause: sql`b = 1` },
        { clause: sql`c = ${"x"}` },
      ]).args,
    ).toEqual([1, 2, "x"]);
  });
});
