/**
 * Row comparisons for tests that read an ordered set with the `sql` tag. The
 * read and its whole expected result stay one call, so each test states the
 * rows it wants without repeating the query wrapper.
 */

import { expect } from "@std/expect";
import { queryAll } from "#db/client.ts";
import type { SqlStatement } from "#db/sql.ts";

/** The rows one statement returns, compared as a whole. */
export const expectQueryRows = async <T>(
  statement: SqlStatement,
  expected: readonly T[],
): Promise<void> => {
  expect(await queryAll<T>(statement)).toEqual(expected);
};
