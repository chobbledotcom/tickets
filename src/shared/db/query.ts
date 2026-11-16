import type { Row } from "@libsql/client";
import { queryAll } from "#db/client.ts";
import { type SqlStatement, sqlName } from "#db/sql.ts";

/** A row of whole numbers by column. SQLite gives a COUNT or a SUM back as a
 * number or as a bigint. */
export type WholeNumberRow<Column extends string> = Record<
  Column,
  number | bigint
>;

/** Collapse a result's rows to the set of one column's values, as strings.
 * The reads that ask which names or ids exist share this tail: applied
 * migrations, live table columns, index names and trigger names. */
export const stringColumnSet = (rows: Row[], column: string): Set<string> =>
  new Set(rows.map((row) => String(row[column])));

/** Run a single-column SELECT and collect that column's values into a Set of
 * strings — the shared shape of the "which hashes/names already exist" reads
 * (e.g. the live table names, the unsubscribed contact hashes). */
export const queryColumnSet = async (
  statement: SqlStatement,
  column: string,
): Promise<Set<string>> =>
  stringColumnSet(await queryAll<Row>(statement), column);

export const columnFrom =
  (sourceName: string): ((name: string) => SqlStatement) =>
  (name: string): SqlStatement =>
    sqlName(`${sourceName}.${name}`);

/** Whether a failed batch tripped a guard's NOT NULL insert — the one shape
 * every guard abort surfaces with, named by the constraint that tripped it. */
export const notNullGuardFailure = (error: unknown, column: string): boolean =>
  error instanceof Error &&
  error.message.includes(`NOT NULL constraint failed: ${column}`);

/** The same check with one constraint fixed now, for a caller that owns a
 *  single deliberate guard column. */
export const notNullGuardFailureAt =
  (column: string) =>
  (error: unknown): boolean =>
    notNullGuardFailure(error, column);

/** A batch loader: takes a list of ids and returns, for each id, the list of
 * related numbers found for it. Ids with no matches are absent from the map. */
export type ListsByIds = (ids: number[]) => Promise<Map<number, number[]>>;

