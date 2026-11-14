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

/** One column and the exact text it must spell. */
type ColumnSpelling = readonly [column: unknown, spelled: string];

/** Each row is one test: the columns it pins, in the order given. A wrong
 *  spelling here changes the schema of many tables at once. */
const spellings: readonly {
  readonly name: string;
  readonly columns: readonly ColumnSpelling[];
}[] = [
  {
    columns: [
      [textOrNull, "TEXT"],
      [wholeNumberOrNull, "INTEGER"],
    ],
    name: "spells a column that may hold nothing",
  },
  {
    columns: [
      [text, "TEXT NOT NULL"],
      [wholeNumber, "INTEGER NOT NULL"],
      [real, "REAL NOT NULL"],
    ],
    name: "spells a column that always holds a value",
  },
  {
    columns: [
      [textStartingBlank, "TEXT NOT NULL DEFAULT ''"],
      [wholeNumberStartingAtZero, "INTEGER NOT NULL DEFAULT 0"],
      [wholeNumberStartingAtOne, "INTEGER NOT NULL DEFAULT 1"],
    ],
    name: "gives a new column its starting value",
  },
  {
    columns: [
      [defaulted(text, "none"), "TEXT NOT NULL DEFAULT 'none'"],
      [defaulted(wholeNumber, 90), "INTEGER NOT NULL DEFAULT 90"],
    ],
    name: "starts a column at the value it names",
  },
  {
    columns: [
      [textStartingAtNull, "TEXT DEFAULT NULL"],
      [wholeNumberStartingAtNull, "INTEGER DEFAULT NULL"],
    ],
    name: "starts a column at nothing, as older columns hold it",
  },
  {
    columns: [[rowId, "INTEGER PRIMARY KEY AUTOINCREMENT"]],
    name: "grows the row's own id",
  },
  {
    columns: [
      // SQLite lets a text key hold nothing, so the required mark is added here.
      [textKey, "TEXT PRIMARY KEY"],
      [requiredTextKey, "TEXT PRIMARY KEY NOT NULL"],
    ],
    name: "marks a text key that must always be found",
  },
];

describe("schema column types", () => {
  for (const { columns, name } of spellings) {
    test(name, () => {
      for (const [column, spelled] of columns) {
        expect(sqlText(column)).toBe(spelled);
      }
    });
  }

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
