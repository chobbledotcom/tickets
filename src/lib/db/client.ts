/**
 * Database client setup and core utilities
 *
 * When query logging is enabled (admin debug footer), the core query
 * functions (queryOne, queryAll, queryBatch, deleteByField) time each
 * call and record the SQL via the query-log module.
 */

import {
  type Client,
  createClient,
  type InValue,
  type ResultSet,
  type TransactionMode,
} from "@libsql/client";
import { lazyRef } from "#fp";
import {
  addQueryLogEntry,
  isQueryLogEnabled,
  trackQuery,
} from "#lib/db/query-log.ts";
import { getEnv } from "#lib/env.ts";

const createDbClient = (): Client => {
  const url = getEnv("DB_URL");
  if (!url) {
    throw new Error("DB_URL environment variable is required");
  }
  return createClient({
    url,
    authToken: getEnv("DB_TOKEN"),
  });
};

const [dbGetter, dbSetter] = lazyRef(createDbClient);

/**
 * Get or create database client
 */
export const getDb = (): Client => dbGetter();

/**
 * Set database client (for testing)
 */
export const setDb = (client: Client | null): void => dbSetter(client);

/** Cast libsql ResultSet rows to a typed array (single centralized assertion) */
export const resultRows = <T>(result: ResultSet): T[] =>
  result.rows as unknown as T[];

/** Query single row, returning null if not found */
export const queryOne = async <T>(
  sql: string,
  args: InValue[],
): Promise<T | null> => {
  const result = await trackQuery(sql, () => getDb().execute({ sql, args }));
  const rows = resultRows<T>(result);
  return rows.length === 0 ? null : rows[0]!;
};

/** Query all rows, returning a typed array */
export const queryAll = async <T>(
  sql: string,
  args?: InValue[],
): Promise<T[]> => {
  const result = await trackQuery(sql, () =>
    args ? getDb().execute({ sql, args }) : getDb().execute(sql),
  );
  return resultRows<T>(result);
};

/** Delete rows matching a field value */
export const deleteByField = async (
  table: string,
  field: string,
  value: InValue,
): Promise<void> => {
  const sql = `DELETE FROM ${table} WHERE ${field} = ?`;
  await trackQuery(sql, () => getDb().execute({ sql, args: [value] }));
};

/** Delete rows from multiple tables in a single batch transaction */
export const deleteByFieldBatch = (
  deletes: Array<{ table: string; field: string; value: InValue }>,
): Promise<void> =>
  executeBatch(
    deletes.map(({ table, field, value }) => ({
      sql: `DELETE FROM ${table} WHERE ${field} = ?`,
      args: [value],
    })),
  );

/** Execute a batch with optional query logging and timing */
const trackedBatch = async (
  statements: Array<{ sql: string; args: InValue[] }>,
  mode: TransactionMode,
): Promise<ResultSet[]> => {
  if (!isQueryLogEnabled()) return getDb().batch(statements, mode);
  const start = performance.now();
  const results = await getDb().batch(statements, mode);
  const elapsed = performance.now() - start;
  for (const stmt of statements) addQueryLogEntry(stmt.sql, elapsed);
  return results;
};

/** Create a batch executor for a given transaction mode */
const batchFor =
  (mode: TransactionMode) =>
  (statements: Array<{ sql: string; args: InValue[] }>): Promise<ResultSet[]> =>
    trackedBatch(statements, mode);

/** Execute multiple read queries in a single round-trip using Turso batch API. */
export const queryBatch = batchFor("read");

/**
 * Execute multiple write statements and return their ResultSets.
 * Statements run in order within a single transaction (Turso batch API).
 * Ideal for cascading deletes and multi-step writes.
 */
export const executeBatchWithResults = batchFor("write");

/** Execute multiple write statements, discarding results. */
export const executeBatch = async (
  statements: Array<{ sql: string; args: InValue[] }>,
): Promise<void> => {
  await executeBatchWithResults(statements);
};

/** Build SQL placeholders for an IN clause, e.g. "?, ?, ?" */
export const inPlaceholders = (values: readonly unknown[]): string =>
  values.map(() => "?").join(", ");
