/**
 * Unit tests for the clause shapes that a write shares
 * (`src/shared/db/where-clauses.ts`). They build text and values with no
 * database.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { among, equal, named } from "#db/select/expression.ts";
import { sql } from "#db/sql.ts";
import { deleteWhere, equalityClauses } from "#db/where-clauses.ts";

describe("deleteWhere", () => {
  const deleteThings = deleteWhere("things");

  test("deletes the rows that pass every condition", () => {
    expect(
      deleteThings([equal(named("kind"), "note"), among(named("id"), [4, 5])]),
    ).toEqual(
      sql`DELETE FROM things WHERE kind = ${"note"} AND id IN (${4}, ${5})`,
    );
  });

  test("deletes every row when no condition narrows it", () => {
    expect(deleteThings([]).sql).toBe("DELETE FROM things");
  });

  test("refuses a table that is not a name", () => {
    expect(() => deleteWhere("things; --")([])).toThrow(
      'Not a valid SQL name: "things; --"',
    );
  });
});

describe("equalityClauses", () => {
  test("writes one comparison for each column, with its value bound", () => {
    expect(equalityClauses({ id: 7, name: "x" })).toEqual([
      sql`id = ${7}`,
      sql`name = ${"x"}`,
    ]);
  });

  test("takes a statement as a value", () => {
    expect(equalityClauses({ uses: sql`uses + 1` })).toEqual([
      sql`uses = ${sql`uses + 1`}`,
    ]);
  });
});
