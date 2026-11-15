/** Helpers for tests that read one column of a declared payment table. */

import type { Table } from "#db/migrations/schema/types.ts";

/** The SQL one column of a declared table carries, or nothing when the table
 *  declares that column not at all. */
export const columnSql = (table: Table, wanted: string): string =>
  table.columns.find(([held]) => held === wanted)?.[1].sql ?? "";
