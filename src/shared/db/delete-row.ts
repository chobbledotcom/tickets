/** One DELETE over a table, its conditions written as the row they match. */

import type { InValue } from "@libsql/client";
import { type SqlStatement, sql, sqlJoin, sqlName } from "#db/sql.ts";
import { equalityClauses } from "#db/where-clauses.ts";

/**
 * Build a DELETE statement, the WHERE record ANDed as equality checks. A
 * delete needing a richer guard — `IS NULL`, an inequality, a subquery — keeps
 * its own SQL rather than bending this one.
 */
export const deleteFrom = (
  table: string,
  where: Record<string, InValue>,
): SqlStatement =>
  sql`DELETE FROM ${sqlName(table)} WHERE ${sqlJoin(
    equalityClauses(where),
    sql` AND `,
  )}`;
