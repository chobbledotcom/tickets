/** The "exactly one row came back" assertion: a query or diff that must
 *  answer a single row names the row once, then checks its fields. */

import { expect } from "@std/expect";

/** Assert `rows` holds exactly one row and that its `expected` fields carry
 *  those values; returns the row for the checks `expected` does not name. */
export const expectSoleRow = <T extends object>(
  rows: readonly T[],
  expected: Partial<T>,
): T => {
  expect(rows.length).toBe(1);
  const row = rows[0]!;
  for (const [field, value] of Object.entries(expected)) {
    expect((row as Record<string, unknown>)[field]).toEqual(value);
  }
  return row;
};
