/**
 * These say only what a column *is*. What a payment may say, and how it may
 * behave, belongs to the record layer in TypeScript, where a broken rule names
 * itself, unit tests without a database, and changes without rebuilding a table
 * already full of real money.
 *
 * The one exception is anything holding the buyer's details. That rule checks
 * what actually landed in the column, which is the one thing TypeScript cannot
 * see: a type says `string` while the value is bytes.
 */

import {
  checked,
  rowId,
  text,
  wholeNumber,
} from "#db/migrations/schema/scalar-columns.ts";
import type { Column, Table } from "#db/migrations/schema/types.ts";
import { sql, sqlLiteral, sqlName, type SqlStatement } from "#db/sql.ts";

/**
 * A value counts as hidden only if it is really text, says how it was hidden,
 * and carries every part needed to read it back. A bare prefix with the buyer's
 * details after it is refused, because nothing could read that back either.
 *
 * "Really text" matters as much as the shape. SQLite leaves bytes alone in a
 * TEXT column while GLOB turns them into text just long enough to look at, so
 * bytes spelling an envelope pass and are then stored as bytes. GLOB's ?* also
 * swallows separators, so the second half refuses one more than the envelope
 * has.
 */
const sealed = (name: string, prefix: string, parts: number): SqlStatement => {
  const column = sqlName(name);
  return sql`(typeof(${column}) = 'text' AND ${column} GLOB ${sqlLiteral(
    `${prefix}${":?*".repeat(parts)}`,
  )} AND ${column} NOT GLOB ${sqlLiteral(
    `${prefix}${":*".repeat(parts + 1)}`,
  )})`;
};

/** The same rule, for a column a row can leave empty. It is written for a
 *  CHECK, which supplies the outer brackets. */
export const ownerEncryptedRuleOrNull = (name: string): SqlStatement =>
  sql`${sqlName(name)} IS NULL OR ${sealed(name, "hyb:1", 3)}`;

/** A column that must hold a value hidden for the owner with their key. */
export const ownerEncryptedColumn = (name: string): Column => [
  name,
  checked(sealed(name, "hyb:1", 3))(text),
];

/** When a row was made and last touched. Every payment record carries both. */
export const madeAndTouched: Column[] = [
  ["created_at", wholeNumber],
  ["updated_at", wholeNumber],
];

/**
 * Every record hanging off a payment opens the same way: its own row id, then
 * the payment it belongs to. Written once here so a new one cannot start any
 * other way.
 */
export const paymentRecord = (
  name: string,
  parts: {
    columns: Column[];
    indexes: NonNullable<Table["indexes"]>;
  },
): [name: string, table: Table] => [
  name,
  {
    columns: [["id", rowId], ["payment_id", text], ...parts.columns],
    indexes: parts.indexes,
  },
];
