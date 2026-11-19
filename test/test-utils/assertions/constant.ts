/** Exact-value assertions for a module's published constants: the one
 *  implementation behind every test that pins a constant to its value. */

import { expect } from "@std/expect";

/** Assert a module constant holds exactly its published value. The failure
 *  names the constant, so a bare number in the report is easy to trace. */
export const expectConstantValue = <T>(
  name: string,
  actual: T,
  expected: T,
): void => {
  expect(actual, name).toBe(expected);
};
