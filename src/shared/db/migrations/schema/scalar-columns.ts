/** The column types the schema stores, and how SQLite spells each one.

Every table names its columns' types through this file, so a spelling lives in
one place instead of in every table that uses it. A value here is one column's
type together with the marks that go with it, such as `NOT NULL` or a starting
value. The table supplies the column's name. A type says only how the database
stores the value. What the value means belongs to the code that reads the
column.

These spellings are SQLite's, the only database this schema runs on. A second
database changes the values below. It also changes the rules a table adds with
`checked` and `aboutTheRow`, and the statements that `schema-sync.ts` builds. */

/** Text that the column always holds. */
export const text = "TEXT NOT NULL";

/** Text, or nothing. */
export const textOrNull = "TEXT";

/** Text that the column always holds, and that starts blank. */
export const textStartingBlank = "TEXT NOT NULL DEFAULT ''";

/** Text, or nothing, that starts at nothing. Older columns hold their empty
 *  value this way. */
export const textStartingAtNull = "TEXT DEFAULT NULL";

/** A required type with the value a new row starts at. A number stands as
 *  itself, and text is quoted. */
export const defaulted = (type: string, startingAt: string | number): string =>
  `${type} DEFAULT ${typeof startingAt === "number" ? startingAt : `'${startingAt}'`}`;

/** A whole number that the column always holds. */
export const wholeNumber = "INTEGER NOT NULL";

/** A whole number, or nothing. */
export const wholeNumberOrNull = "INTEGER";

/** A whole number that the column always holds, and that starts at zero. */
export const wholeNumberStartingAtZero = "INTEGER NOT NULL DEFAULT 0";

/** A whole number that the column always holds, and that starts at one. */
export const wholeNumberStartingAtOne = "INTEGER NOT NULL DEFAULT 1";

/** A whole number, or nothing, that starts at nothing. Older columns hold
 *  their empty value this way. */
export const wholeNumberStartingAtNull = "INTEGER DEFAULT NULL";

/** A measured number that the column always holds. */
export const real = "REAL NOT NULL";

/** The row's own id, which the database grows by itself. */
export const rowId = "INTEGER PRIMARY KEY AUTOINCREMENT";

/** A text key. SQLite still lets a text key hold nothing, so a key that must
 *  always be found uses {@link requiredTextKey}. */
export const textKey = "TEXT PRIMARY KEY";

/** A text key that must always be found. */
export const requiredTextKey = "TEXT PRIMARY KEY NOT NULL";

/** A rule about this column's own value, in SQL. */
export const checked =
  (rule: string) =>
  (type: string): string =>
    `${type} CHECK (${rule})`;

/** Rules about the whole row. SQLite lets a table say them only on a column.
 *  They hang on the row's last column, one per line, aligned to read inside the
 *  generated statement. */
export const aboutTheRow =
  (rules: readonly string[]) =>
  (type: string): string =>
    [type, ...rules.map((rule) => `CHECK (${rule})`)].join("\n          ");
