/** The column type registry: every table's columns come from here, so a wrong
 *  spelling would change the schema of many tables at once. Pin it exactly. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  aboutTheRow,
  checked,
  columnFacts,
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
import type { ColumnKind } from "#db/migrations/schema/types.ts";
import { sql } from "#db/sql.ts";
import { sqlText } from "#test-utils/sql-text.ts";

/** One column and the exact text it must spell. */
type ColumnSpelling = readonly [column: unknown, spelled: string];

/** Each row is one test: the case name, then the columns it pins, each with
 *  the exact text it must spell. A wrong spelling here changes the schema of
 *  many tables at once. */
const spellings: readonly (readonly [
  name: string,
  ...columns: ColumnSpelling[],
])[] = [
  [
    "spells a column that may hold nothing",
    [textOrNull, "TEXT"],
    [wholeNumberOrNull, "INTEGER"],
  ],
  [
    "spells a column that always holds a value",
    [text, "TEXT NOT NULL"],
    [wholeNumber, "INTEGER NOT NULL"],
    [real, "REAL NOT NULL"],
  ],
  [
    "gives a new column its starting value",
    [textStartingBlank, "TEXT NOT NULL DEFAULT ''"],
    [wholeNumberStartingAtZero, "INTEGER NOT NULL DEFAULT 0"],
    [wholeNumberStartingAtOne, "INTEGER NOT NULL DEFAULT 1"],
  ],
  [
    "starts a column at the value it names",
    [defaulted(text, "none"), "TEXT NOT NULL DEFAULT 'none'"],
    [defaulted(wholeNumber, 90), "INTEGER NOT NULL DEFAULT 90"],
  ],
  [
    "starts a column at nothing, as older columns hold it",
    [textStartingAtNull, "TEXT DEFAULT NULL"],
    [wholeNumberStartingAtNull, "INTEGER DEFAULT NULL"],
  ],
  ["grows the row's own id", [rowId, "INTEGER PRIMARY KEY AUTOINCREMENT"]],
  [
    "marks a text key that must always be found",
    // SQLite lets a text key hold nothing, so the required mark is added
    // here.
    [textKey, "TEXT PRIMARY KEY"],
    [requiredTextKey, "TEXT PRIMARY KEY NOT NULL"],
  ],
];

describe("schema column types", () => {
  for (const [name, ...columns] of spellings) {
    test(name, () => {
      const spelled = columns.map(([column]) => sqlText(column));
      const expected = columns.map(([, spelling]) => spelling);
      expect(spelled).toEqual(expected);
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

  test("names the words of a fixed set as the stored value", () => {
    const state = oneOf("state", ["active", "refunded"])(textOrNull);
    const stored: ColumnKind<"active" | "refunded" | null, "optional"> = state;
    // @ts-expect-error the column can hold a word, so it is not always empty
    const refused: ColumnKind<null, "optional"> = state;
    expect(columnFacts(stored)).toEqual({ canBeNull: true });
    expect(refused).toBe(state);
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

describe("columnFacts", () => {
  test("says whether a row can hold nothing in the column", () => {
    expect(columnFacts(text)).toEqual({ canBeNull: false });
    expect(columnFacts(textOrNull)).toEqual({ canBeNull: true });
  });

  test("keeps the facts of a type under a rule and a starting value", () => {
    const ruled = checked(sql`a > 0`)(defaulted(wholeNumberOrNull, 1));
    expect(columnFacts(ruled)).toEqual({ canBeNull: true });
  });

  test("refuses SQL that is not a column type of this module", () => {
    expect(() => columnFacts(sql`TEXT NOT NULL`)).toThrow(
      "Not a column type from scalar-columns.ts: TEXT NOT NULL",
    );
  });
});
