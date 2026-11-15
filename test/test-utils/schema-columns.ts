import { expect } from "@std/expect";
import type { Table } from "#db/migrations/schema/types.ts";

/** A declared table is this name and this column list, in this order: adding,
 *  dropping, or moving a column changes what a row may say. */
export const expectSchemaColumns = (
  [name, table]: readonly [name: string, table: Table],
  expectedName: string,
  expectedColumns: readonly string[],
): void => {
  expect(name).toBe(expectedName);
  expect(table.columns.map(([held]) => held)).toEqual(expectedColumns);
};
