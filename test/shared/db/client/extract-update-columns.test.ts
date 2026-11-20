import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { extractUpdateColumns } from "#db/client.ts";

/**
 * The SET-clause column sniff: a write invalidates a cache keyed on the columns
 * it names, so a missed or invented column silently leaves a stale cache in
 * place.
 */
describe("extractUpdateColumns", () => {
  // Each value below must not stop the top-level scan. An emoji is two UTF-16
  // code units, ')(' and ')' shift a paren depth, and a doubled quote hides a
  // comma inside one value. A scan that trips on any of them reads the next
  // column as part of the value, so the write sniffs the wrong table and its
  // cache is never invalidated.
  const noteValues = [
    ["columns after an astral character still split at the comma", "\u{1F600}"],
    ["columns after a bracket inside a value still split at the comma", "')('"],
    ["columns after an unbalanced bracket inside a quoted value", "')'"],
    ["a doubled quote keeps its comma inside one value", "'a'', b'"],
  ] as const;

  /** One parse shape per case: name, SQL text, and the column names it must
   *  yield, compared as a set. */
  const cases: [name: string, text: string, expected: string[]][] = [
    [
      "single column assignment",
      "UPDATE listing_attendees SET checked_in = ? WHERE attendee_id = ? AND listing_id = ?",
      ["checked_in"],
    ],
    [
      "multiple column assignments",
      "UPDATE t SET a = a + 1, b = ?",
      ["a", "b"],
    ],
    [
      "WHERE clause = signs are not mistaken for assignments",
      "UPDATE users SET password_hash = ?, invite_code_hash = ?, invite_expiry = ? WHERE id = ?",
      ["invite_code_hash", "invite_expiry", "password_hash"],
    ],
    [
      "table-qualified column name strips the qualifier",
      "UPDATE t SET t.col = ?",
      ["col"],
    ],
    [
      "quoted column name strips the quotes",
      'UPDATE t SET "my_col" = ?',
      ["my_col"],
    ],
    [
      "commas inside parentheses in an expression do not split the assignment",
      "UPDATE t SET a = coalesce(x, 0), b = ?",
      ["a", "b"],
    ],
    ...noteValues.map(([name, value]): [string, string, string[]] => [
      name,
      `UPDATE t SET note = ${value}, quantity = 1`,
      ["note", "quantity"],
    ]),
    // Synthetic SQL whose SET clause opens with "(": the paren-depth scan must
    // see that first character, otherwise depth goes negative at ")" and the
    // top-level comma never splits, losing the second assignment.
    [
      "depth scan starts at the very first character of the SET clause",
      "UPDATE t SET (a) = 1, b = 2",
      ["(a)", "b"],
    ],
    ["column names are lower-cased", "UPDATE t SET MyCol = ?", ["mycol"]],
  ];

  for (const [name, text, expected] of cases) {
    test(name, () => {
      const cols = extractUpdateColumns(text);
      expect([...cols!].sort()).toEqual([...expected].sort());
    });
  }

  // Empty content between SET and WHERE covers the eqIdx < 0 guard; a
  // non-UPDATE has no SET clause at all. Both mean "cannot read the columns".
  const nullCases: [name: string, text: string][] = [
    [
      "returns null for non-UPDATE SQL (no SET clause)",
      "INSERT INTO t (a) VALUES (?)",
    ],
    [
      "returns null when SET clause has no parseable assignments",
      "UPDATE t SET WHERE true",
    ],
  ];

  for (const [name, text] of nullCases) {
    test(name, () => {
      expect(extractUpdateColumns(text)).toBeNull();
    });
  }
});
