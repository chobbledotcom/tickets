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

describe("schema column types", () => {
  test("spells a column that may hold nothing", () => {
    expect(textOrNull).toBe("TEXT");
    expect(wholeNumberOrNull).toBe("INTEGER");
  });

  test("spells a column that always holds a value", () => {
    expect(text).toBe("TEXT NOT NULL");
    expect(wholeNumber).toBe("INTEGER NOT NULL");
    expect(real).toBe("REAL NOT NULL");
  });

  test("gives a new column its starting value", () => {
    expect(textStartingBlank).toBe("TEXT NOT NULL DEFAULT ''");
    expect(wholeNumberStartingAtZero).toBe("INTEGER NOT NULL DEFAULT 0");
    expect(wholeNumberStartingAtOne).toBe("INTEGER NOT NULL DEFAULT 1");
  });

  test("starts a column at the value it names", () => {
    expect(defaulted(text, "none")).toBe("TEXT NOT NULL DEFAULT 'none'");
    expect(defaulted(wholeNumber, 90)).toBe("INTEGER NOT NULL DEFAULT 90");
  });

  test("starts a column at nothing, as older columns hold it", () => {
    expect(textStartingAtNull).toBe("TEXT DEFAULT NULL");
    expect(wholeNumberStartingAtNull).toBe("INTEGER DEFAULT NULL");
  });

  test("grows the row's own id", () => {
    expect(rowId).toBe("INTEGER PRIMARY KEY AUTOINCREMENT");
  });

  test("marks a text key that must always be found", () => {
    // SQLite lets a text key hold nothing, so the required mark is added here.
    expect(textKey).toBe("TEXT PRIMARY KEY");
    expect(requiredTextKey).toBe("TEXT PRIMARY KEY NOT NULL");
  });

  test("adds a rule about the column's own value", () => {
    expect(checked(sql`state IN ('active', 'refunded')`)(text)).toBe(
      "TEXT NOT NULL CHECK (state IN ('active', 'refunded'))",
    );
    // A rule comes after the column's starting value.
    expect(
      checked(sql`type IN ('system', 'owner')`)(defaulted(text, "system")),
    ).toBe(
      "TEXT NOT NULL DEFAULT 'system' CHECK (type IN ('system', 'owner'))",
    );
  });

  test("holds one of a fixed set of words", () => {
    expect(oneOf("state", ["active", "refunded"])(text)).toBe(
      "TEXT NOT NULL CHECK (state IN ('active', 'refunded'))",
    );
    // The rule comes after the column's starting value, as any other rule does.
    expect(
      oneOf("updates", ["alpha", "beta", "release"])(
        defaulted(text, "release"),
      ),
    ).toBe(
      "TEXT NOT NULL DEFAULT 'release' CHECK (updates IN ('alpha', 'beta', 'release'))",
    );
  });

  test("hangs a rule about the whole row on its last column", () => {
    expect(
      aboutTheRow([sql`a IS NULL`, sql`b IS NULL`])(wholeNumberOrNull).sql,
    ).toBe("INTEGER\n          CHECK (a IS NULL)\n          CHECK (b IS NULL)");
  });

  test("leaves a row with no rules as it is", () => {
    expect(aboutTheRow([])(wholeNumberOrNull).sql).toBe("INTEGER");
  });
});
