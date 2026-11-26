import type { Client } from "@libsql/client";
import { execute, getDb } from "#db/client.ts";
import type { SqlStatement } from "#db/sql.ts";

/** The libsql client behind `getDb()`, with the SDK's own text methods. Only
 * for a test that replays SQL text it did not write, such as a wire request.
 * The one unsafe cast lives here. */
export const rawDbClient = (): Client => getDb() as Client;

/** Runs one write statement that a test uses to set up or break stored data.
 * The test has no use for the result, so none comes back. */
export const runWrite = async (statement: SqlStatement): Promise<void> => {
  await execute(statement);
};
