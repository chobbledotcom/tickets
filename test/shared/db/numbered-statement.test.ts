import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { numberedStatement } from "#db/numbered-statement.ts";

describe("numberedStatement", () => {
  test("binds one value once wherever its token appears", () => {
    const statement = numberedStatement((bind) => {
      const id = bind(7);
      const quantity = bind(3);
      return `SELECT ${quantity} AS quantity, ${id} AS first_id, ${id} AS second_id`;
    });

    expect(statement).toEqual({
      args: [7, 3],
      sql: "SELECT ?2 AS quantity, ?1 AS first_id, ?1 AS second_id",
    });
  });

  test("gives dynamic values distinct slots in their input order", () => {
    const statement = numberedStatement((bind) => {
      const owner = bind("owner");
      const ids = [4, 8].map(bind).join(", ");
      return `SELECT ${owner} WHERE id IN (${ids})`;
    });

    expect(statement).toEqual({
      args: ["owner", 4, 8],
      sql: "SELECT ?1 WHERE id IN (?2, ?3)",
    });
  });

  test("reuses one slot for a repeated date across many clauses", () => {
    const statement = numberedStatement((bind) => {
      const day = bind("2026-05-01");
      return `SELECT 1 WHERE a = ${bind(7)} AND b = ${day} AND c = ${bind(7)}`;
    });

    expect(statement).toEqual({
      args: ["2026-05-01", 7],
      sql: "SELECT 1 WHERE a = ?2 AND b = ?1 AND c = ?2",
    });
  });

  test("keeps equal-looking values of different types apart", () => {
    const statement = numberedStatement(
      (bind) =>
        `SELECT ${bind(1)} AS number, ${bind("1")} AS text, ${bind(1)} AS again`,
    );

    expect(statement).toEqual({
      args: [1, "1"],
      sql: "SELECT ?1 AS number, ?2 AS text, ?1 AS again",
    });
  });
});
