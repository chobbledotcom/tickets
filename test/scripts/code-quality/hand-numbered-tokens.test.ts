import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { findHandNumberedSql } from "#test/scripts/code-quality/numbered-binds.ts";

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

  test("fires on a hand-numbered fragment a template interpolation carries", () => {
    expect(
      findHandNumberedSql(
        "shared/db/synthetic.ts",
        'const sql = `DELETE FROM t WHERE ${byParent ? "parent_id = ?1" : "id = ?"}`;',
      ),
    ).toEqual([
      "shared/db/synthetic.ts:1: SQL text carries a hand-numbered ?N token; build the statement through numberedStatement instead",
    ]);
  });

  test("fires on a hand-numbered fragment a nested template carries", () => {
    expect(
      findHandNumberedSql(
        "shared/db/synthetic.ts",
        'const sql = `DELETE FROM t WHERE ${byParent ? `child_id = ?1` : ""}`;',
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

  test("fires on a quoted statement a SQL helper call carries", () => {
    expect(
      findHandNumberedSql(
        "shared/db/synthetic.ts",
        'await execute("DELETE FROM t WHERE parent_id = ?1 OR child_id = ?1", [id]);',
      ),
    ).toEqual([
      "shared/db/synthetic.ts:1: SQL text carries a hand-numbered ?N token; build the statement through numberedStatement instead",
    ]);
  });

  test("reads past a comment before the statement a helper call carries", () => {
    expect(
      findHandNumberedSql(
        "shared/db/synthetic.ts",
        'await execute(/* find */ "DELETE FROM t WHERE id = ?1", [id]);',
      ),
    ).toEqual([
      "shared/db/synthetic.ts:1: SQL text carries a hand-numbered ?N token; build the statement through numberedStatement instead",
    ]);
  });

  test("stays quiet on a helper call whose text ends before its argument", () => {
    expect(
      findHandNumberedSql(
        "shared/db/synthetic.ts",
        "const rows = await queryOne(",
      ),
    ).toEqual([]);
  });

  test("fires on an sql property that opens the file", () => {
    expect(findHandNumberedSql("shared/db/synthetic.ts", 'sql: "?1"')).toEqual([
      "shared/db/synthetic.ts:1: SQL text carries a hand-numbered ?N token; build the statement through numberedStatement instead",
    ]);
  });

  test("stays quiet on a string that opens the file", () => {
    expect(findHandNumberedSql("shared/db/synthetic.ts", '"?1"')).toEqual([]);
  });

  test("stays quiet on another property whose value is a string", () => {
    expect(findHandNumberedSql("shared/db/synthetic.ts", 'key: "?1"')).toEqual(
      [],
    );
  });

  test("stays quiet on a data string that follows an sql argument", () => {
    expect(
      findHandNumberedSql(
        "shared/db/synthetic.ts",
        'const line = format(sql, "Row ?1 is missing");',
      ),
    ).toEqual([]);
  });

  test("stays quiet on a property whose name ends in sql", () => {
    expect(
      findHandNumberedSql(
        "shared/db/synthetic.ts",
        'const s = { tsql: "?1" };',
      ),
    ).toEqual([]);
  });

  test("stays quiet when the file opens with a colon and a string", () => {
    expect(findHandNumberedSql("shared/db/synthetic.ts", 's: "?1"')).toEqual(
      [],
    );
  });

  test("fires on an sql property whose value sits on the next line", () => {
    expect(
      findHandNumberedSql(
        "shared/db/synthetic.ts",
        'const statement = {\n  args: [id],\n  sql:\n    "DELETE FROM t WHERE id = ?1",\n};',
      ),
    ).toEqual([
      "shared/db/synthetic.ts:4: SQL text carries a hand-numbered ?N token; build the statement through numberedStatement instead",
    ]);
  });

  test("fires on SQL text a template variable holds", () => {
    expect(
      findHandNumberedSql(
        "shared/db/synthetic.ts",
        "const sql = `SELECT ?1 FROM t WHERE x = ?`;",
      ),
    ).toEqual([
      "shared/db/synthetic.ts:1: SQL text carries a hand-numbered ?N token; build the statement through numberedStatement instead",
    ]);
  });

  test("stays quiet on a string that is not SQL text", () => {
    expect(
      findHandNumberedSql(
        "shared/db/synthetic.ts",
        'const message = "Choose option ?1 to continue";',
      ),
    ).toEqual([]);
  });

  test("stays quiet on a string a helper call binds rather than runs", () => {
    expect(
      findHandNumberedSql(
        "shared/db/synthetic.ts",
        'await execute(writeSql, ["option ?1"]);',
      ),
    ).toEqual([]);
  });

  test("fires on a statement a local constant holds for a helper call", () => {
    expect(
      findHandNumberedSql(
        "shared/db/synthetic.ts",
        [
          'const statement = "SELECT id FROM t WHERE parent_id = ?1";',
          "const rows = await execute(statement, [id]);",
        ].join("\n"),
      ),
    ).toEqual([
      "shared/db/synthetic.ts:1: SQL text carries a hand-numbered ?N token; build the statement through numberedStatement instead",
    ]);
  });

  test("fires on a quoted statement the sql name holds", () => {
    expect(
      findHandNumberedSql(
        "shared/db/synthetic.ts",
        'const sql = "DELETE FROM t WHERE id = ?1";',
      ),
    ).toEqual([
      "shared/db/synthetic.ts:1: SQL text carries a hand-numbered ?N token; build the statement through numberedStatement instead",
    ]);
  });

  test("stays quiet on a constant a non-SQL call receives", () => {
    expect(
      findHandNumberedSql(
        "shared/db/synthetic.ts",
        [
          'const message = "Expected ?1 binds, got 0";',
          "logWarning(message);",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("stays quiet on a call whose first argument is not a bare name", () => {
    expect(
      findHandNumberedSql(
        "shared/db/synthetic.ts",
        [
          'const message = "Expected ?1 binds, got 0";',
          "execute(build(message), [id]);",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("stays quiet on a constant no call receives", () => {
    expect(
      findHandNumberedSql(
        "shared/db/synthetic.ts",
        [
          'const message = "Expected ?1 binds, got 0";',
          "return message.length;",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});
