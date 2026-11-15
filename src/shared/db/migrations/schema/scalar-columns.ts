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

import {
  type SqlStatement,
  sql,
  sqlCommas,
  sqlJoin,
  sqlLiteral,
  sqlName,
} from "#db/sql.ts";
import type { ColumnKind, RefersTo } from "./types.ts";

/** Name the value a stored row holds in a column of this type. */
const storing = <Stored>(type: SqlStatement): ColumnKind<Stored> =>
  type as ColumnKind<Stored>;

/** A type with more SQL after it holds the same value as the type it wraps. */
const sameKind = <Kind extends SqlStatement>(
  _wrapped: Kind,
  built: SqlStatement,
): Kind => built as Kind;

/** Text that the column always holds. */
export const text = storing<string>(sql`TEXT NOT NULL`);

/** Text, or nothing. */
export const textOrNull = storing<string | null>(sql`TEXT`);

/** Text that the column always holds, and that starts blank. */
export const textStartingBlank = storing<string>(
  sql`TEXT NOT NULL DEFAULT ''`,
);

/** Text, or nothing, that starts at nothing. Older columns hold their empty
 *  value this way. */
export const textStartingAtNull = storing<string | null>(
  sql`TEXT DEFAULT NULL`,
);

/** A required type with the value a new row starts at. A number stands as
 *  itself, and text is quoted. */
export const defaulted = <Kind extends SqlStatement>(
  type: Kind,
  startingAt: string | number,
): Kind => sameKind(type, sql`${type} DEFAULT ${sqlLiteral(startingAt)}`);

/** A whole number that the column always holds. */
export const wholeNumber = storing<number>(sql`INTEGER NOT NULL`);

/** A whole number, or nothing. */
export const wholeNumberOrNull = storing<number | null>(sql`INTEGER`);

/** A whole number that the column always holds, and that starts at zero. */
export const wholeNumberStartingAtZero = storing<number>(
  sql`INTEGER NOT NULL DEFAULT 0`,
);

/** A whole number that the column always holds, and that starts at one. */
export const wholeNumberStartingAtOne = storing<number>(
  sql`INTEGER NOT NULL DEFAULT 1`,
);

/** A whole number, or nothing, that starts at nothing. Older columns hold
 *  their empty value this way. */
export const wholeNumberStartingAtNull = storing<number | null>(
  sql`INTEGER DEFAULT NULL`,
);

/** A measured number that the column always holds. */
export const real = storing<number>(sql`REAL NOT NULL`);

/** The row's own id, which the database grows by itself. */
export const rowId = storing<number>(sql`INTEGER PRIMARY KEY AUTOINCREMENT`);

/** A text key. SQLite still lets a text key hold nothing, so a key that must
 *  always be found uses {@link requiredTextKey}. */
export const textKey = storing<string>(sql`TEXT PRIMARY KEY`);

/** A text key that must always be found. */
export const requiredTextKey = storing<string>(
  sql`TEXT PRIMARY KEY NOT NULL`,
);

/** A rule about this column's own value, in SQL. */
export const checked =
  (rule: SqlStatement) =>
  <Kind extends SqlStatement>(type: Kind): Kind =>
    sameKind(type, sql`${type} CHECK (${rule})`);

/** A type that must hold one of a fixed set of words, in SQL. Read the words
 *  from the one module that names them, so the column and the form or API that
 *  sends them cannot drift apart. */
export const oneOf =
  (column: string, words: readonly string[]) =>
  <Kind extends SqlStatement>(type: Kind): Kind =>
    checked(sql`${sqlName(column)} IN (${sqlCommas(words.map(sqlLiteral))})`)(
      type,
    );

/** Rules about the whole row. SQLite lets a table say them only on a column.
 *  They hang on the row's last column, one per line, aligned to read inside the
 *  generated statement. */
export const aboutTheRow =
  (rules: readonly SqlStatement[]) =>
  <Kind extends SqlStatement>(type: Kind): Kind =>
    sameKind(
      type,
      sqlJoin(
        [type, ...rules.map((rule) => sql`CHECK (${rule})`)],
        sql`\n          `,
      ),
    );

/** The table each referring column type points at. */
const referredTables = new WeakMap<SqlStatement, string>();

/** A column that holds the `id` of a row in `target`. The SQL text of the type
 *  stays the same. A read joins the two tables along this column. */
export const refersTo =
  <Target extends string>(target: Target) =>
  <Kind extends SqlStatement>(type: Kind): Kind & RefersTo<Target> => {
    const referring = sql`${type}`;
    referredTables.set(referring, target);
    return referring as Kind & RefersTo<Target>;
  };

/** The table that a column type refers to. Null for a column that holds no
 *  reference, which is most columns. */
export const referredTableOrNull = (type: SqlStatement): string | null =>
  referredTables.get(type) ?? null;
