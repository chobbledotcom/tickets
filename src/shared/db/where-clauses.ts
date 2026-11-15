/**
 * The clause shapes that a write shares: the rows a DELETE removes, and the
 * `column = value` list of an UPDATE. A read says its conditions with
 * `#db/select/expression.ts`.
 */

import { type Condition, whereTail } from "#db/select/expression.ts";
import { type SqlSlot, type SqlStatement, sql, sqlName } from "#db/sql.ts";

/** A delete over the rows that pass every condition it is given. */
type DeleteFromTable = (where: readonly Condition[]) => SqlStatement;

/** A delete over the rows of `table` that some conditions keep. */
export const deleteWhere =
  (table: string): DeleteFromTable =>
  (where) =>
    sql`DELETE FROM ${sqlName(table)}${whereTail(where)}`;

/** One `column = value` per entry: the shared clause shape of an UPDATE's SET
 *  and WHERE parts, and of a DELETE's WHERE part. A value can be a statement,
 *  such as a counter increment. */
export const equalityClauses = (
  values: Record<string, SqlSlot>,
): SqlStatement[] =>
  Object.entries(values).map(
    ([column, value]) => sql`${sqlName(column)} = ${value}`,
  );
