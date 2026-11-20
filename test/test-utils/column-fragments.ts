/** One implementation for tests that pin a shared column fragment's SQL. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { sqlText } from "#test-utils/sql-text.ts";

/** A column fragment, the name of its test, and the SQL text it must make. */
export interface ColumnFragmentCase {
  readonly fragment: unknown;
  readonly name: string;
  readonly text: unknown;
}

/** Registers one test per fragment, so a flipped word fails under the name
 *  that says which fragment it is. */
export const testColumnFragments = (
  cases: readonly ColumnFragmentCase[],
): void => {
  for (const { fragment, name, text } of cases) {
    test(name, () => {
      expect(sqlText(fragment)).toEqual(text);
    });
  }
};
