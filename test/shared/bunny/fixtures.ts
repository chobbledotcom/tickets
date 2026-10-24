import { assertExists, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";

/** Assert a `{ ok: false; error }` result whose error contains `contains`. */
export const expectErrorResult = (
  result: { ok: boolean; error?: string },
  contains: string,
): void => {
  expect(result.ok).toBe(false);
  assertExists(result.error);
  assertStringIncludes(result.error, contains);
};
