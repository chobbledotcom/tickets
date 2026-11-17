import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { queryAll } from "#db/client.ts";
import type { SqlStatement } from "#db/sql.ts";
import { columnNames } from "#test-utils/db/migration-test-helpers.ts";

/**
 * Assert a column-drop migration removed `column` from `table` and that the
 * table rebuild kept its data: `select` must read back exactly `expected`.
 */
export const expectColumnDroppedKeeping = async <Row>(
  table: string,
  column: string,
  select: SqlStatement,
  expected: readonly Row[],
): Promise<void> => {
  assert(!(await columnNames(table)).includes(column));
  expect(await queryAll<Row>(select)).toEqual(expected);
};
