/**
 * Reads of the live schema: what the database holds now, not what the schema
 * declares.
 */

import { getDb } from "#db/client.ts";
import { type SqlStatement, sql, sqlName } from "#db/sql.ts";

/** The name and the CREATE text of each live index that `filter` keeps. */
export const liveIndexRows = async (filter: SqlStatement) =>
  (
    await getDb().execute(
      sql`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND ${filter}`,
    )
  ).rows;

/** The rows that one PRAGMA reports for a table. */
export const pragmaRows = async (
  pragma: "foreign_key_list" | "table_info",
  table: string,
) =>
  (await getDb().execute(sql`PRAGMA ${sqlName(pragma)}(${sqlName(table)})`))
    .rows;
