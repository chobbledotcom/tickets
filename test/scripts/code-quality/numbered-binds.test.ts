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

  test("stays quiet on a repeat inside the allowed declaration", () => {
    expect(
      findRepeatedBinds(
        "shared/accounting/queries.ts",
        `const accountsScope = (accounts: AccountRef[]): WhereClause => {
  const part = { args: [type, ...ids, type, ...ids], clause };
  return { args: part.args, clause };
};`,
        ["shared/accounting/queries.ts:accountsScope"],
      ),
    ).toEqual([]);
  });

  test("fires on a repeat outside the allowed declaration", () => {
    expect(
      findRepeatedBinds(
        "shared/accounting/queries.ts",
        `const accountsScope = (accounts: AccountRef[]): WhereClause => {
  const part = { args: [type, ...ids, type, ...ids], clause };
};
const transfersFor = { args: [id, id], sql: transferSql };`,
        ["shared/accounting/queries.ts:accountsScope"],
      ),
    ).toEqual([
      "shared/accounting/queries.ts:4: binds id more than once; numberedStatement binds it once and reuses the token",
    ]);
  });

  test("fires when the allowed declaration has no brace group", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        "const scope = assemble;\nlet ids = [batchId, batchId];\nawait execute(writeSql, ids);",
        ["shared/db/synthetic.ts:scope"],
      ),
    ).toEqual([
      "shared/db/synthetic.ts:2: binds batchId more than once; numberedStatement binds it once and reuses the token",
    ]);
  });

  test("fires when the allowed declaration never closes", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        "const scope = () => {\nconst statement = { args: [id, id], sql };",
        ["shared/db/synthetic.ts:scope"],
      ),
    ).toEqual([
      "shared/db/synthetic.ts:2: binds id more than once; numberedStatement binds it once and reuses the token",
    ]);
  });

  test("fires when the allowed declaration is absent", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        "const statement = { args: [id, id], sql };",
        ["shared/db/synthetic.ts:missing"],
      ),
    ).toEqual([
      "shared/db/synthetic.ts:1: binds id more than once; numberedStatement binds it once and reuses the token",
    ]);
  });

  test("skips an args array that never closes", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        "const partial = { args: [listingId, listingId,",
        [],
      ),
    ).toEqual([]);
  });

  test("fires on a local array an execute call carries into a statement", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        "let args = [listingId, listingId];\nawait execute(writeSql, args);",
        [],
      ),
    ).toEqual([
      "shared/db/synthetic.ts:1: binds listingId more than once; numberedStatement binds it once and reuses the token",
    ]);
  });

  test("skips a local array that never closes", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        "let broken = [listingId, listingId;\nawait execute(writeSql, broken);",
        [],
      ),
    ).toEqual([]);
  });

  test("judges a file an allowed declaration does not name", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        "let args = [listingId, listingId];\nawait execute(writeSql, args);",
        ["shared/accounting/queries.ts:accountsScope"],
      ),
    ).toEqual([
      "shared/db/synthetic.ts:1: binds listingId more than once; numberedStatement binds it once and reuses the token",
    ]);
  });

  test("stays quiet on a local array whose values are all distinct", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        "const args = [listingId, priceType];\nawait execute(writeSql, args);",
        [],
      ),
    ).toEqual([]);
  });

  test("fires on a local array an object shorthand carries into a statement", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        `const args = [sessionId, sessionId];
const statement = { args, sql };
await tx.execute({ args, sql });`,
        [],
      ),
    ).toEqual([
      "shared/db/synthetic.ts:1: binds sessionId more than once; numberedStatement binds it once and reuses the token",
      "shared/db/synthetic.ts:1: binds sessionId more than once; numberedStatement binds it once and reuses the token",
    ]);
  });

  test("fires on a local array an args property names", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        "const ids = [batchId, batchId];\nconst statement = { args: ids, sql };",
        [],
      ),
    ).toEqual([
      "shared/db/synthetic.ts:1: binds batchId more than once; numberedStatement binds it once and reuses the token",
    ]);
  });

  test("expands a spread of a local array", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        "const extra = [ownerId, ownerId];\nconst statement = { args: [...extra], sql };",
        [],
      ),
    ).toEqual([
      "shared/db/synthetic.ts:2: binds ownerId more than once; numberedStatement binds it once and reuses the token",
    ]);
  });

  test("stays quiet when the referenced array is not a local literal", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        `const statement = { args: row.values, sql: row.sql };
await execute(row.sql, row.values);
await execute(row.sql);`,
        [],
      ),
    ).toEqual([]);
  });

  test("stays quiet on an execute call that never closes", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        "let args = [listingId, listingId];\nawait execute(writeSql",
        [],
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

  test("walks a nested brace inside an interpolation", () => {
    expect(
      findHandNumberedSql(
        "shared/db/synthetic.ts",
        'const sql = `SELECT ?1 FROM t WHERE x = ${ { ok: true }.ok ? "a" : "b" }`;',
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
