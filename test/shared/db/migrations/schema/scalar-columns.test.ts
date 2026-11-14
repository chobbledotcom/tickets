/** The column type registry: every table's columns come from here, so a wrong
 *  spelling would change the schema of many tables at once. Pin it exactly. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  aboutTheRow,
  checked,
  defaulted,
  oneOf,
  real,
  requiredTextKey,
  rowId,
  text,
  textKey,
  textOrNull,
  textStartingAtNull,
  textStartingBlank,
  wholeNumber,
  wholeNumberOrNull,
  wholeNumberStartingAtNull,
  wholeNumberStartingAtOne,
  wholeNumberStartingAtZero,
} from "#db/migrations/schema/scalar-columns.ts";
import { sql } from "#db/sql.ts";
import { sqlText } from "#test-utils/sql-text.ts";

describe("schema column types", () => {
  test("spells a column that may hold nothing", () => {
    expect(sqlText(textOrNull)).toBe("TEXT");
    expect(sqlText(wholeNumberOrNull)).toBe("INTEGER");
  });

  test("spells a column that always holds a value", () => {
    expect(sqlText(text)).toBe("TEXT NOT NULL");
    expect(sqlText(wholeNumber)).toBe("INTEGER NOT NULL");
    expect(sqlText(real)).toBe("REAL NOT NULL");
  });

  test("gives a new column its starting value", () => {
    expect(sqlText(textStartingBlank)).toBe("TEXT NOT NULL DEFAULT ''");
    expect(sqlText(wholeNumberStartingAtZero)).toBe(
      "INTEGER NOT NULL DEFAULT 0",
    );
    expect(sqlText(wholeNumberStartingAtOne)).toBe(
      "INTEGER NOT NULL DEFAULT 1",
    );
  });

  test("starts a column at the value it names", () => {
    expect(sqlText(defaulted(text, "none"))).toBe(
      "TEXT NOT NULL DEFAULT 'none'",
    );
    expect(sqlText(defaulted(wholeNumber, 90))).toBe(
      "INTEGER NOT NULL DEFAULT 90",
    );
  });

  test("starts a column at nothing, as older columns hold it", () => {
    expect(sqlText(textStartingAtNull)).toBe("TEXT DEFAULT NULL");
    expect(sqlText(wholeNumberStartingAtNull)).toBe("INTEGER DEFAULT NULL");
  });

  test("grows the row's own id", () => {
    expect(sqlText(rowId)).toBe("INTEGER PRIMARY KEY AUTOINCREMENT");
  });

  test("marks a text key that must always be found", () => {
    // SQLite lets a text key hold nothing, so the required mark is added here.
    expect(sqlText(textKey)).toBe("TEXT PRIMARY KEY");
    expect(sqlText(requiredTextKey)).toBe("TEXT PRIMARY KEY NOT NULL");
  });

  test("adds a rule about the column's own value", () => {
    expect(sqlText(checked(sql`state IN ('active', 'refunded')`)(text))).toBe(
      "TEXT NOT NULL CHECK (state IN ('active', 'refunded'))",
    );
    // A rule comes after the column's starting value.
    expect(
      sqlText(
        checked(sql`type IN ('system', 'owner')`)(defaulted(text, "system")),
      ),
    ).toBe(
      "TEXT NOT NULL DEFAULT 'system' CHECK (type IN ('system', 'owner'))",
    );
  });

  test("holds one of a fixed set of words", () => {
    expect(sqlText(oneOf("state", ["active", "refunded"])(text))).toBe(
      "TEXT NOT NULL CHECK (state IN ('active', 'refunded'))",
    );
    // The rule comes after the column's starting value, as any other rule does.
    expect(
      sqlText(
        oneOf("updates", ["alpha", "beta", "release"])(
          defaulted(text, "release"),
        ),
      ),
    ).toBe(
      "TEXT NOT NULL DEFAULT 'release' CHECK (updates IN ('alpha', 'beta', 'release'))",
    );
  });

  test("hangs a rule about the whole row on its last column", () => {
    expect(
      sqlText(
        aboutTheRow([sql`a IS NULL`, sql`b IS NULL`])(wholeNumberOrNull).sql,
      ),
    ).toBe("INTEGER\n          CHECK (a IS NULL)\n          CHECK (b IS NULL)");
  });

  test("leaves a row with no rules as it is", () => {
    expect(sqlText(aboutTheRow([])(wholeNumberOrNull).sql)).toBe("INTEGER");
  });
});
