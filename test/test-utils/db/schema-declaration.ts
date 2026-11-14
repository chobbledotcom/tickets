/** Assertions over a declarative table group: the exact declaration hash, and
 *  one named table inside it. Every schema suite that pins a table group reads
 *  its tables through these, so a rename fails in one place. */

import { expect } from "@std/expect";
import type { Table } from "#db/migrations/schema/types.ts";
import { jsonHash } from "#test-utils/hash.ts";
import { sqlText } from "#test-utils/sql-text.ts";

/** A table group as the schema modules export it. */
export type DeclaredTables = [name: string, table: Table][];

/** Assert the whole declaration keeps its exact hash. The hash pins every
 *  column, index, and default in the group. */
export const expectSchemaDeclarationExact = async (
  tables: DeclaredTables,
  hash: string,
): Promise<void> => {
  expect(await jsonHash(sqlText(tables))).toBe(hash);
};

/** The named table in a declaration. The throw names the missing table, so a
 *  rename fails loudly rather than asserting against `undefined`. */
export const schemaTableNamed = (
  tables: DeclaredTables,
  name: string,
): Table => {
  const found = tables.find(([tableName]) => tableName === name);
  if (!found) throw new Error(`${name} schema is missing`);
  return found[1];
};
