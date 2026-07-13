/**
 * A minimal `{ id, name }` table for exercising the REST factories
 * (`writeEntity`, `defineCrudApi`) without a real domain table. Kept here so the
 * REST test suites share one fixture rather than each re-declaring the table and
 * its DDL.
 */

import { getDb } from "#shared/db/client.ts";
import { col, defineTable, type Table } from "#shared/db/table.ts";

export type IdNameRow = { id: number; name: string };
export type IdNameInput = { name: string };

/** A `{ id, name }` table definition backed by `name`. */
export const makeIdNameTable = (name: string): Table<IdNameRow, IdNameInput> =>
  defineTable<IdNameRow, IdNameInput>({
    name,
    primaryKey: "id",
    schema: { id: col.generated<number>(), name: col.simple<string>() },
  });

/** Create the backing table for {@link makeIdNameTable} in the current test DB. */
export const createIdNameTable = async (name: string): Promise<void> => {
  await getDb().execute(
    `CREATE TABLE IF NOT EXISTS ${name} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`,
  );
};
