/** Assertions over a declarative table group: the exact declaration hash, and
 *  one named table inside it. Every schema suite that pins a table group reads
 *  its tables through these, so a rename fails in one place. */

import { expect } from "@std/expect";
import type { NamedTable, Table } from "#db/migrations/schema/types.ts";
import { requireValue } from "#shared/required-value.ts";
import { jsonHash } from "#test-utils/hash.ts";
import { sqlText } from "#test-utils/sql-text.ts";

/** A table group as the schema modules export it. */
export type DeclaredTables = readonly NamedTable[];

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
export const schemaTableNamed = (tables: DeclaredTables, name: string): Table =>
  requireValue(
    tables.find(([tableName]) => tableName === name),
    `${name} schema is missing`,
  )[1];
