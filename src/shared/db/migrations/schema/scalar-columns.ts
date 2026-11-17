/** The column types the schema stores, and how SQLite spells each one.

Every table names its columns' types through this file, so a spelling lives in
one place instead of in every table that uses it. A value here is one column's
type together with the marks that go with it, such as `NOT NULL` or a starting
value. The table supplies the column's name. A type says how the database
stores the value. A type from `oneOf` also names the words that the column
can hold. `#db/select/tables.ts` names the values that no rule checks.

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
import type { ColumnKind, Filling } from "./types.ts";

/** What a read must know about a column type beyond its SQL text. */
type ColumnFacts = {
  /** Whether a row can hold nothing in the column. */
  readonly canBeNull: boolean;
};

const factsOfType = new WeakMap<SqlStatement, ColumnFacts>();

const withFacts = <Kind extends SqlStatement>(
  type: SqlStatement,
  facts: ColumnFacts,
): Kind => {
  factsOfType.set(type, facts);
  return type as Kind;
};

/** The facts of a column type. Every type that this module makes has them. */
export const columnFacts = (type: SqlStatement): ColumnFacts => {
  const facts = factsOfType.get(type);
  if (facts === undefined) {
    throw new Error(`Not a column type from scalar-columns.ts: ${type.sql}`);
  }
  return facts;
};

/** A type whose column always holds a value. */
const storing = <Stored, Fill extends Filling = "given">(
  type: SqlStatement,
): ColumnKind<Stored, Fill> => withFacts(type, { canBeNull: false });

/** A type whose column always holds a value, and that a new row can leave
 *  out because the database fills it. */
const storingFrom = <Stored>(
  type: SqlStatement,
): ColumnKind<Stored, "optional"> => storing<Stored, "optional">(type);

/** A type whose column can hold nothing. A new row can leave it out. */
const storingOrNull = <Stored>(
  type: SqlStatement,
): ColumnKind<Stored | null, "optional"> =>
  withFacts(type, { canBeNull: true });

/** A type with more SQL after it holds the same value as the type it wraps. */
const sameKind = <Kind extends SqlStatement>(
  wrapped: Kind,
  built: SqlStatement,
): Kind => withFacts(built, columnFacts(wrapped));

/** Text that the column always holds. */
export const text = storing<string>(sql`TEXT NOT NULL`);

/** Text, or nothing. */
export const textOrNull = storingOrNull<string>(sql`TEXT`);

/** Text that the column always holds, and that starts blank. */
export const textStartingBlank = storingFrom<string>(
  sql`TEXT NOT NULL DEFAULT ''`,
);

/** Text, or nothing, that starts at nothing. Older columns hold their empty
 *  value this way. */
export const textStartingAtNull = storingOrNull<string>(sql`TEXT DEFAULT NULL`);

/** A required type with the value a new row starts at. A number stands as
 *  itself, and text is quoted. */
export const defaulted = <Stored, Fill extends Filling>(
  type: ColumnKind<Stored, Fill>,
  startingAt: string | number,
): ColumnKind<Stored, "optional"> =>
  withFacts(sql`${type} DEFAULT ${sqlLiteral(startingAt)}`, columnFacts(type));

/** A whole number that the column always holds. */
export const wholeNumber = storing<number>(sql`INTEGER NOT NULL`);

/** A whole number, or nothing. */
export const wholeNumberOrNull = storingOrNull<number>(sql`INTEGER`);

/** A whole number that the column always holds, and that starts at zero. */
export const wholeNumberStartingAtZero = storingFrom<number>(
  sql`INTEGER NOT NULL DEFAULT 0`,
);

/** A whole number that the column always holds, and that starts at one. */
export const wholeNumberStartingAtOne = storingFrom<number>(
  sql`INTEGER NOT NULL DEFAULT 1`,
);

/** A whole number, or nothing, that starts at nothing. Older columns hold
 *  their empty value this way. */
export const wholeNumberStartingAtNull =
  storingOrNull<number>(sql`INTEGER DEFAULT NULL`);

/** A measured number that the column always holds. */
export const real = storing<number>(sql`REAL NOT NULL`);

/** The row's own id, which the database grows by itself. */
export const rowId = storingFrom<number>(
  sql`INTEGER PRIMARY KEY AUTOINCREMENT`,
);

/** A text key. SQLite still lets a text key hold nothing, so a key that must
 *  always be found uses {@link requiredTextKey}. */
export const textKey = storing<string>(sql`TEXT PRIMARY KEY`);

/** A text key that must always be found. */
export const requiredTextKey = storing<string>(sql`TEXT PRIMARY KEY NOT NULL`);

/** A column type with a rule added. The type still stores the same value. */
type WithRule = <Kind extends SqlStatement>(type: Kind) => Kind;

/** A rule about this column's own value, in SQL. */
export const checked =
  (rule: SqlStatement): WithRule =>
  (type) =>
    sameKind(type, sql`${type} CHECK (${rule})`);

/** A type that must hold one of a fixed set of words, in SQL. Read the words
 *  from the one module that names them, so the column and the form or API that
 *  sends them cannot drift apart. */
export const oneOf =
  <const Words extends readonly string[]>(column: string, words: Words) =>
  <Stored extends string | null, Fill extends Filling>(
    type: ColumnKind<Stored, Fill>,
  ): ColumnKind<Words[number] | Extract<Stored, null>, Fill> =>
    checked(sql`${sqlName(column)} IN (${sqlCommas(words.map(sqlLiteral))})`)(
      type,
    ) as ColumnKind<Words[number] | Extract<Stored, null>, Fill>;

/** Rules about the whole row. SQLite lets a table say them only on a column.
 *  They hang on the row's last column, one per line, aligned to read inside the
 *  generated statement. */
export const aboutTheRow =
  (rules: readonly SqlStatement[]): WithRule =>
  (type) =>
    sameKind(
      type,
      sqlJoin(
        [type, ...rules.map((rule) => sql`CHECK (${rule})`)],
        sql`\n          `,
      ),
    );
