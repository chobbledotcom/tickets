import { inPlaceholders, type SqlStatement } from "#db/client.ts";

/** One SQL statement over a list of ids: the ids are the bind arguments and
 * the SQL names them in one IN (...) group. Give the SQL with the placeholder
 * text dropped in where the id list goes. */
export const idListStatement =
  (sql: (ids: string) => string) =>
  (ids: readonly number[]): SqlStatement => ({
    args: [...ids],
    sql: sql(inPlaceholders(ids)),
  });
