/** A fresh in-memory database with the production schema, then the given
 *  writes. A model producer runs its production statements there, so one fact
 *  never reads or writes another fact's rows. */

import { type Client, createClient } from "@libsql/client";

import { fullSchemaCreateStatements } from "#db/migrations/schema-sync.ts";
import type { SqlStatement } from "#db/sql.ts";

export const schemaClientWith = async (
  writes: readonly (SqlStatement | string)[],
): Promise<Client> => {
  const client = createClient({ url: ":memory:" });
  for (const sql of fullSchemaCreateStatements()) await client.execute(sql);
  for (const write of writes) await client.execute(write);
  return client;
};
