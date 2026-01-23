/**
 * Database client setup and core utilities
 */

import { type Client, createClient, type InValue } from "@libsql/client";
import { lazyRef } from "#fp";

const createDbClient = (): Client => {
  const url = process.env.DB_URL;
  if (!url) {
    throw new Error("DB_URL environment variable is required");
  }
  return createClient({
    url,
    authToken: process.env.DB_TOKEN,
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

/** Query single row, returning null if not found */
export const queryOne = async <T>(
  sql: string,
  args: InValue[],
): Promise<T | null> => {
  const result = await getDb().execute({ sql, args });
  return result.rows.length === 0 ? null : (result.rows[0] as unknown as T);
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
