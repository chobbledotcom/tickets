/**
 * Writes that a guard can refuse: a guard row that aborts a batch, and a write
 * that reports whether it changed a row.
 */

import { execute } from "#db/client.ts";
import { type SqlStatement, sql } from "#db/sql.ts";

/** A guard that aborts its batch unless a condition holds. It inserts `row`,
 * which holds a NULL that `target` refuses, when the condition fails. */
export const abortUnless =
  (target: SqlStatement, row: SqlStatement) =>
  (condition: SqlStatement): SqlStatement =>
    sql`INSERT INTO ${target} SELECT ${row} WHERE NOT (${condition})`;

/** Run a guarded write and report whether it changed a row. Zero rows means
 * that the guard refused the write: a replay, a race, or a row in another
 * state. */
export const executeChangedRow = async (
  statement: SqlStatement,
): Promise<boolean> => (await execute(statement)).rowsAffected > 0;
