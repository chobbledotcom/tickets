/** Table-driven checks over the SQL a declared table stores in one column. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { Table } from "#db/migrations/schema/types.ts";
import { columnSql } from "#test/shared/db/migrations/schema/payments/column-sql.ts";

/** One case: the test's name, the column it reads, and the SQL that column
 *  must store. */
export type ColumnSqlCase = readonly [
  name: string,
  column: string,
  sql: string,
];

/** A test per case, so each column's rule keeps its own name. */
export const testColumnSql = (
  table: Table,
  cases: readonly ColumnSqlCase[],
): void => {
  for (const [name, column, sql] of cases) {
    test(name, () => {
      expect(columnSql(table, column)).toBe(sql);
    });
  }
};
