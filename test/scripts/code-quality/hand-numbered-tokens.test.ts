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
});
