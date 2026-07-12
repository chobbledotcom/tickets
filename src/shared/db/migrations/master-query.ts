import type { Client, InValue, Row } from "@libsql/client";

/**
 * Run a one-argument query on the given connection and hand back its rows.
 *
 * Shared by the migration helpers that read `sqlite_master` for a single table
 * or index name. Takes the connection as an argument so callers that own their
 * own `getDb` (the injected migration context) and callers that use the shared
 * client both go through the same path.
 */
export const queryRowsWithArg = async (
  db: Client,
  sql: string,
  arg: InValue,
): Promise<Row[]> => (await db.execute({ args: [arg], sql })).rows;
