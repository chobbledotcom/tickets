import { expect } from "@std/expect";

/** Assert a `{ ok: false; error }` result whose error contains `contains`. */
export const expectErrorResult = (
  result: { ok: boolean; error?: string },
  contains: string,
): void => {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain(contains);
};
