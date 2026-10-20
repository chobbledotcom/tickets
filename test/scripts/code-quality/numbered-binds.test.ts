import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  findHandNumberedSql,
  findRepeatedBinds,
} from "#test/scripts/code-quality/numbered-binds.ts";

describe("repeated binds", () => {
  test("fires on a statement that binds one value twice", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        `const statement = {
  args: [listingId, PRICE_TYPE_BASE, listingId],
  sql: "DELETE FROM listing_prices WHERE listing_id = ? AND price_type = ? AND EXISTS (SELECT 1 FROM listings WHERE id = ?)",
};`,
        [],
      ),
    ).toEqual([
      "shared/db/synthetic.ts:2: binds listingId more than once; numberedStatement binds it once and reuses the token",
    ]);
  });

  test("fires on a statement that binds one variable list twice", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        "const statement = { args: [...ids, ...ids], sql: query };",
        [],
      ),
    ).toEqual([
      "shared/db/synthetic.ts:1: binds ids more than once; numberedStatement binds it once and reuses the token",
    ]);
  });

  test("stays quiet on statements whose arguments are all distinct", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        `const statement = {
  args: [listingId, PRICE_TYPE_BASE, ""],
  sql: insertSql,
};
const other = { args: [row.sessionId, row.slot], sql: row.sql };
const typed = { args: [first.name, second.name], sql: namesSql };`,
        [],
      ),
    ).toEqual([]);
  });

  test("stays quiet on a call whose two answers may differ", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        "const statement = { args: [nowIso(), nowIso()], sql: stampSql };",
        [],
      ),
    ).toEqual([]);
  });

  test("stays quiet on a type annotation", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        "function make(): { args: [string, number, string]; sql: string } {",
        [],
      ),
    ).toEqual([]);
  });

  test("stays quiet on an allowed prefix", () => {
    expect(
      findRepeatedBinds(
        "shared/accounting/queries.ts",
        "const statement = { args: [type, ...ids, type, ...ids], sql: q };",
        ["shared/accounting/"],
      ),
    ).toEqual([]);
  });
});

describe("hand-numbered tokens", () => {
  test("fires on SQL text that spells a ?N parameter", () => {
    expect(
      findHandNumberedSql(
        "shared/db/synthetic.ts",
        'const statement = { args: [id], sql: "DELETE FROM t WHERE parent_id = ?1 OR child_id = ?1" };',
      ),
    ).toEqual([
      "shared/db/synthetic.ts:1: SQL text carries a hand-numbered ?N token; build the statement through numberedStatement instead",
    ]);
  });

  test("fires inside a template but never inside its interpolation", () => {
    expect(
      findHandNumberedSql(
        "shared/db/synthetic.ts",
        'const sql = `SELECT ?1 FROM t WHERE x = ${cond ?1 ? "a" : "b"}`;',
      ),
    ).toEqual([
      "shared/db/synthetic.ts:1: SQL text carries a hand-numbered ?N token; build the statement through numberedStatement instead",
    ]);
  });

  test("never reads a comment", () => {
    expect(
      findHandNumberedSql(
        "shared/db/synthetic.ts",
        "// Both arms compare against the same cutoff, bound once as ?1.\nconst cutoff = 1;",
      ),
    ).toEqual([]);
  });

  test("stays quiet on the binder that owns the tokens", () => {
    expect(
      findHandNumberedSql(
        "shared/db/numbered-statement.ts",
        "const token = `?${next}`;",
      ),
    ).toEqual([]);
  });

  test("stays quiet on unnumbered placeholders", () => {
    expect(
      findHandNumberedSql(
        "shared/db/synthetic.ts",
        'const statement = { args: [id], sql: "DELETE FROM t WHERE id = ?" };',
      ),
    ).toEqual([]);
  });
});
