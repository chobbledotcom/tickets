import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { idListStatement } from "#db/id-list-statement.ts";

describe("db id-list-statement", () => {
  it("binds the ids as arguments and puts one placeholder group in the SQL", () => {
    const statement = idListStatement(
      (ids) => `SELECT id FROM t WHERE id IN (${ids})`,
    )([7, 9]);

    expect(statement).toEqual({
      args: [7, 9],
      sql: "SELECT id FROM t WHERE id IN (?, ?)",
    });
  });

  it("binds an id list to one placeholder group and the ids as arguments", () => {
    const statement = idListStatement((ids) => `id IN (${ids})`)([4]);

    expect(statement).toEqual({ args: [4], sql: "id IN (?)" });
  });
});
