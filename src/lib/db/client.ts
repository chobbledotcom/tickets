/**
 * Database client setup and core utilities
 */

import { type Client, createClient, type InValue, type ResultSet } from "@libsql/client";
import { lazyRef } from "#fp";
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
  const result = await getDb().execute({ sql, args });
  const rows = resultRows<T>(result);
  return rows.length === 0 ? null : rows[0]!;
};

/** Query all rows, returning a typed array */
export const queryAll = async <T>(
  sql: string,
  args?: InValue[],
): Promise<T[]> => {
  const result = args
    ? await getDb().execute({ sql, args })
    : await getDb().execute(sql);
  return resultRows<T>(result);
};

/** Execute delete by field */
export const executeByField = async (
  table: string,
  field: string,
  value: InValue,
): Promise<void> => {
  await getDb().execute({
    sql: `DELETE FROM ${table} WHERE ${field} = ?`,
    args: [value],
  });
};

/**
 * Execute multiple queries in a single round-trip using Turso batch API.
 * Significantly reduces latency for remote databases.
 */
export const queryBatch = (
  statements: Array<{ sql: string; args: InValue[] }>,
): Promise<ResultSet[]> => getDb().batch(statements, "read");

/** Build SQL placeholders for an IN clause, e.g. "?, ?, ?" */
export const inPlaceholders = (values: readonly unknown[]): string =>
  values.map(() => "?").join(", ");
