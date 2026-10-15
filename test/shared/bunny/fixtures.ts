import { expect } from "@std/expect";
import { says } from "#test-utils/says.ts";

/** Assert a `{ ok: false; error }` result whose error contains `contains`. */
export const expectErrorResult = (
  result: { ok: boolean; error?: string },
  contains: string,
): void => {
  expect(result.ok).toBe(false);
  if (!result.ok) says(result.error, contains);
};
