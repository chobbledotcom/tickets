import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  findSqlTagViolations,
  findSqlTagViolationsIn,
} from "#test/scripts/code-quality/sql-tag.ts";

const PATH = "shared/db/synthetic.ts";
const PLAIN_SQL = `${PATH}:1: SQL text sits in a plain string; write it in a sql template`;
const PLAIN_PLACEHOLDER = `${PATH}:1: a plain string spells a SQL placeholder; write the SQL in a sql template`;
const TAGGED_PLACEHOLDER = `${PATH}:1: a sql template spells a placeholder; write the value in a slot`;
const CAST = `${PATH}:1: a cast makes a statement; only the sql tag makes one`;
const DUMP = `${PATH}:1: sqlFromDump is for backup restore only`;

const found = (source: string): string[] => findSqlTagViolations(PATH, source);

describe("SQL in a plain string", () => {
  for (const statement of [
    "SELECT id FROM listings",
    "INSERT INTO settings (key) VALUES ('a')",
    "INSERT OR IGNORE INTO settings (key) VALUES ('a')",
    "UPDATE listings SET name = 'a'",
    "DELETE FROM sessions",
    "CREATE TABLE t (id INTEGER)",
    "CREATE UNIQUE INDEX i ON t (id)",
    "DROP TRIGGER trg",
    "ALTER TABLE t ADD COLUMN c",
    "PRAGMA foreign_keys",
  ]) {
    test(`fires on a quoted ${statement.split(" ")[0]} statement: ${statement}`, () => {
      expect(found(`const text = "${statement}";`)).toEqual([PLAIN_SQL]);
    });
  }

  test("fires on a statement in a template with no tag", () => {
    expect(
      found("const text = `SELECT id FROM ${table} WHERE id = ${id}`;"),
    ).toEqual([PLAIN_SQL]);
  });

  test("fires on a statement that starts after white space", () => {
    expect(found("const text = `\n  DELETE FROM sessions`;")).toEqual([
      PLAIN_SQL,
    ]);
  });

  test("fires on a plain string inside a sql template slot", () => {
    expect(
      found('const s = sql`${flag ? "DELETE FROM sessions" : "x"}`;'),
    ).toEqual([PLAIN_SQL]);
  });

  test("reports the line the string starts on", () => {
    expect(
      found('const a = 1;\n\nconst text = "DELETE FROM sessions";'),
    ).toEqual([
      `${PATH}:3: SQL text sits in a plain string; write it in a sql template`,
    ]);
  });

  for (const prose of [
    "Select a listing from the list",
    "Update the listing, then set the price",
    "The DELETE FROM statement removes rows",
    "selected",
  ]) {
    test(`stays quiet on prose: ${prose}`, () => {
      expect(found(`const text = "${prose}";`)).toEqual([]);
    });
  }

  test("stays quiet on SQL in a comment", () => {
    expect(
      found("// SELECT id FROM listings WHERE id = ?\nconst a = 1;"),
    ).toEqual([]);
  });

  test("stays quiet on a file that writes SQL text for another reader", () => {
    expect(
      findSqlTagViolations(PATH, 'const text = "DELETE FROM sessions";', true),
    ).toEqual([]);
  });
});

describe("a placeholder in a plain string", () => {
  for (const fragment of [
    "id = ?",
    "id = ?1",
    "id IN (?, ?)",
    "created < ? AND created > ?",
    "LIMIT ?",
    "VALUES (?2)",
  ]) {
    test(`fires on ${fragment}`, () => {
      expect(found(`const where = "${fragment}";`)).toEqual([
        PLAIN_PLACEHOLDER,
      ]);
    });
  }

  for (const text of [
    "Is this right?",
    "What is 2 = 2 ?? no",
    "/admin/listings?page=2",
    "name GLOB 'enc:1:?*'",
  ]) {
    test(`stays quiet on ${text}`, () => {
      expect(found(`const text = "${text}";`)).toEqual([]);
    });
  }

  test("stays quiet on optional chaining and a ternary in a slot", () => {
    expect(found("const text = `${a?.b} and ${flag ? one : two}`;")).toEqual(
      [],
    );
  });
});

describe("a placeholder in a sql template", () => {
  test("fires on a bare placeholder", () => {
    expect(found("const s = sql`SELECT id FROM t WHERE id = ?`;")).toEqual([
      TAGGED_PLACEHOLDER,
    ]);
  });

  test("fires on a numbered placeholder", () => {
    expect(found("const s = sql`SELECT id FROM t WHERE id = ?1`;")).toEqual([
      TAGGED_PLACEHOLDER,
    ]);
  });

  test("fires on a placeholder in a nested sql template", () => {
    expect(
      found("const s = sql`SELECT id FROM t WHERE ${sql`id = ?`}`;"),
    ).toEqual([TAGGED_PLACEHOLDER]);
  });

  test("stays quiet on a value in a slot", () => {
    expect(found("const s = sql`SELECT id FROM t WHERE id = ${id}`;")).toEqual(
      [],
    );
  });

  test("stays quiet on a question mark inside a quoted SQL literal", () => {
    expect(
      found("const s = sql`SELECT id FROM t WHERE name GLOB 'enc:1:?*'`;"),
    ).toEqual([]);
  });

  test("stays quiet on a question mark in the code of a slot", () => {
    expect(
      found("const s = sql`SELECT id FROM t WHERE ${flag ? one : two}`;"),
    ).toEqual([]);
  });

  test("an escaped slot opener stays SQL text", () => {
    expect(found("const s = sql`SELECT '\\${a}' WHERE id = ?`;")).toEqual([
      TAGGED_PLACEHOLDER,
    ]);
  });

  test("a template of another tag is a plain string", () => {
    expect(found("const s = notsql`id = ?`;")).toEqual([PLAIN_PLACEHOLDER]);
    expect(found("const s = other.sql`id = ?`;")).toEqual([PLAIN_PLACEHOLDER]);
  });
});

describe("ways around the tag", () => {
  test("fires on a cast to a statement", () => {
    expect(found("const s = { args: [], sql: text } as SqlStatement;")).toEqual(
      [CAST],
    );
  });

  test("fires on a cast through unknown", () => {
    expect(found("const s = text as unknown as SqlStatement;")).toEqual([CAST]);
  });

  test("stays quiet on a cast named in a string or a comment", () => {
    expect(
      found('// x as SqlStatement\nconst note = "as SqlStatement";'),
    ).toEqual([]);
  });

  test("stays quiet on a type that only starts with the name", () => {
    expect(found("const s = x as SqlStatementList;")).toEqual([]);
  });

  test("fires on the dump boundary outside backup restore", () => {
    expect(found("const s = sqlFromDump(text);")).toEqual([DUMP]);
  });

  test("lets backup restore name the dump boundary", () => {
    expect(
      findSqlTagViolations(
        "shared/db/backup.ts",
        "const s = sqlFromDump(text);",
      ),
    ).toEqual([]);
  });

  test("judges nothing in the module that makes statements", () => {
    expect(
      findSqlTagViolations(
        "shared/db/sql.ts",
        'const s = { args, sql: "id = ?" } as SqlStatement; sqlFromDump(s);',
      ),
    ).toEqual([]);
  });
});

describe("findSqlTagViolationsIn", () => {
  const contents = new Map([
    ["/root/a.ts", 'const text = "DELETE FROM sessions";'],
    ["/root/b.ts", 'const text = "DELETE FROM users";'],
    ["/root/c.ts", "const s = sql`id = ${id}`;"],
  ]);
  const toRelative = (file: string): string => file.replace("/root/", "");

  test("reports each file by its relative path", () => {
    expect(
      findSqlTagViolationsIn([...contents.keys()], contents, toRelative, []),
    ).toEqual([
      "a.ts:1: SQL text sits in a plain string; write it in a sql template",
      "b.ts:1: SQL text sits in a plain string; write it in a sql template",
    ]);
  });

  test("leaves out a file that can hold plain SQL text", () => {
    expect(
      findSqlTagViolationsIn([...contents.keys()], contents, toRelative, [
        "a.ts",
      ]),
    ).toEqual([
      "b.ts:1: SQL text sits in a plain string; write it in a sql template",
    ]);
  });

  test("throws when a file has no loaded text", () => {
    expect(() =>
      findSqlTagViolationsIn(["/root/missing.ts"], contents, toRelative, []),
    ).toThrow("Missing source text for /root/missing.ts");
  });
});
