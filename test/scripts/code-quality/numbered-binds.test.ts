import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { findRepeatedBinds } from "#test/scripts/code-quality/numbered-binds.ts";

describe("repeated binds", () => {
  test("fires on a statement that binds one value twice", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        `const statement = {
  args: [listingId, PRICE_TYPE_BASE, listingId],
  sql: "DELETE FROM listing_prices WHERE listing_id = ? AND price_type = ? AND EXISTS (SELECT 1 FROM listings WHERE id = ?)",
};`,
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
      ),
    ).toEqual([]);
  });

  test("stays quiet on a call whose two answers may differ", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        "const statement = { args: [nowIso(), nowIso()], sql: stampSql };",
      ),
    ).toEqual([]);
  });

  test("stays quiet on a type annotation", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        "function make(): { args: [string, number, string]; sql: string } {",
      ),
    ).toEqual([]);
  });

  test("skips an args array that never closes", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        "const partial = { args: [listingId, listingId,",
      ),
    ).toEqual([]);
  });

  test("fires on a local array an execute call carries into a statement", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        "let args = [listingId, listingId];\nawait execute(writeSql, args);",
      ),
    ).toEqual([
      "shared/db/synthetic.ts:1: binds listingId more than once; numberedStatement binds it once and reuses the token",
    ]);
  });

  test("fires on a typed local array an execute call carries into a statement", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        "const args: number[] = [listingId, listingId];\nawait execute(writeSql, args);",
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
      ),
    ).toEqual([]);
  });

  test("stays quiet on a local array whose values are all distinct", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        "const args = [listingId, priceType];\nawait execute(writeSql, args);",
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
      ),
    ).toEqual([]);
  });

  test("stays quiet on an execute call that never closes", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        "let args = [listingId, listingId];\nawait execute(writeSql",
      ),
    ).toEqual([]);
  });

  test("fires on an inline array an execute call carries", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        "await execute(writeSql, [sessionId, sessionId]);",
      ),
    ).toEqual([
      "shared/db/synthetic.ts:1: binds sessionId more than once; numberedStatement binds it once and reuses the token",
    ]);
  });

  test("fires on an inline array a generic requireOne call carries", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        [
          "const pair = [acct.type, acct.id];",
          "const row = await requireOne<{ balance: number | bigint }>(",
          "  readSql,",
          "  [...pair, ...pair, ...pair, ...pair],",
          ");",
        ].join("\n"),
      ),
    ).toEqual([
      "shared/db/synthetic.ts:4: binds acct.type more than once; numberedStatement binds it once and reuses the token",
      "shared/db/synthetic.ts:4: binds acct.id more than once; numberedStatement binds it once and reuses the token",
    ]);
  });

  test("fires on a named array a generic queryAll call carries", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        [
          "const ids = [batchId, batchId];",
          "const rows = await queryAll<Row>(readSql, ids);",
        ].join("\n"),
      ),
    ).toEqual([
      "shared/db/synthetic.ts:1: binds batchId more than once; numberedStatement binds it once and reuses the token",
    ]);
  });

  test("fires on an inline array an executeReturningRow call carries", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        "const row = await executeReturningRow<Lockout>(writeSql, [id, id]);",
      ),
    ).toEqual([
      "shared/db/synthetic.ts:1: binds id more than once; numberedStatement binds it once and reuses the token",
    ]);
  });

  test("fires on an inline array a queryIdColumn call carries", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        "const ids = await queryIdColumn(readSql, [ownerId, ownerId]);",
      ),
    ).toEqual([
      "shared/db/synthetic.ts:1: binds ownerId more than once; numberedStatement binds it once and reuses the token",
    ]);
  });

  test("skips a helper call whose inline array never closes", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        "await execute(writeSql, [listingId, listingId",
      ),
    ).toEqual([]);
  });

  test("skips a helper call whose type arguments never close", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        "const count = queryOne < expected ? readSql : writeSql;",
      ),
    ).toEqual([]);
  });

  test("stays quiet on a helper call whose inline array has distinct values", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        [
          "await execute(writeSql, [sessionId, priceType]);",
          "const row = await requireOne<Row>(readSql, [type, id]);",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("stays quiet when two functions declare arrays of one name and bind each once", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        [
          "const readFirst = (id: string) => {",
          "  const ids = [id];",
          "  const statement = { args: [...ids], sql: readSql };",
          "  return statement;",
          "};",
          "const readSecond = (id: string) => {",
          "  const ids = [id];",
          "  const statement = { args: [...ids], sql: otherSql };",
          "  return statement;",
          "};",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("fires only on the function whose own array repeats a value", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        [
          "const readFirst = () => {",
          "  const ids = [batchId, batchId];",
          "  return execute(writeSql, ids);",
          "};",
          "const readSecond = () => {",
          "  const ids = [batchId];",
          "  return execute(otherSql, ids);",
          "};",
        ].join("\n"),
      ),
    ).toEqual([
      "shared/db/synthetic.ts:2: binds batchId more than once; numberedStatement binds it once and reuses the token",
    ]);
  });

  test("keeps an enclosing array visible to a statement inside a nested function", () => {
    expect(
      findRepeatedBinds(
        "shared/db/synthetic.ts",
        [
          "const makeRunner = () => {",
          "  const ids = [ownerId, ownerId];",
          "  return () => execute(writeSql, ids);",
          "};",
        ].join("\n"),
      ),
    ).toEqual([
      "shared/db/synthetic.ts:2: binds ownerId more than once; numberedStatement binds it once and reuses the token",
    ]);
  });
});
