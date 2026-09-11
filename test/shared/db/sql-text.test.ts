import type { Client } from "@libsql/client";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { isReadSql, sqlOf, writeSqlOf } from "#db/sql-text.ts";

describe("SQL text", () => {
  for (const statement of [
    "SELECT ?",
    { args: [2], sql: "SELECT ?" },
    ["SELECT ?", [2]],
  ] satisfies Parameters<Client["batch"]>[0]) {
    test(`reads SQL from ${JSON.stringify(statement)}`, () => {
      expect(sqlOf(statement)).toBe("SELECT ?");
    });
  }

  for (const sql of ["SELECT 1", " \n\tSeLeCt 2", "SELECT(3)"]) {
    test(`recognises a read: ${JSON.stringify(sql)}`, () => {
      expect(isReadSql(sql)).toBe(true);
      expect(writeSqlOf(sql)).toBe(sql);
    });
  }

  for (const sql of [
    "",
    "SELECTED 1",
    "SELECT_1",
    "PRAGMA table_info(listings)",
    "EXPLAIN SELECT 1",
    "-- comment\nSELECT 1",
    "/* comment */ SELECT 1",
    "INSERT INTO listings VALUES (1)",
    "UPDATE listings SET id = 2",
    "DELETE FROM listings",
    "REPLACE INTO listings VALUES (1)",
  ]) {
    test(`does not classify non-SELECT SQL as a read: ${JSON.stringify(sql)}`, () => {
      expect(isReadSql(sql)).toBe(false);
      expect(writeSqlOf(sql)).toBe(sql);
    });
  }

  for (const prefix of [
    "WITH chosen AS (SELECT 1) ",
    "WITH chosen AS (WITH nested AS (SELECT 1) SELECT * FROM nested) ",
    "WITH a$SELECT AS (SELECT 1), \u03b1SELECT\u03b2 AS (SELECT 2) ",
    "WITH chosen AS (SELECT ') SELECT' AS name /* ) SELECT */ -- ) SELECT\n) ",
    'WITH "SELECT"("column") AS (SELECT 1), [INSERT] AS (SELECT 2), `UPDATE` AS (SELECT 3) ',
    " \nwith chosen AS (SELECT (1)), other AS (SELECT 2)\n",
    "WITH RECURSIVE chosen(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM chosen WHERE id < 3) ",
  ]) {
    for (const command of [
      "SELECT * FROM chosen",
      "INSERT INTO listings SELECT * FROM chosen",
      "UPDATE listings SET id = 2",
      "DELETE FROM listings",
      "REPLACE INTO listings SELECT * FROM chosen",
    ]) {
      test(`classifies the final command in ${prefix}${command}`, () => {
        expect(writeSqlOf(prefix + command)).toBe(command);
        expect(isReadSql(prefix + command)).toBe(command.startsWith("SELECT"));
      });
    }
  }

  test("leaves an incomplete CTE unchanged", () => {
    const sql = "WITH chosen AS (SELECT 1)";
    expect(writeSqlOf(sql)).toBe(sql);
    expect(isReadSql(sql)).toBe(false);
  });
});
