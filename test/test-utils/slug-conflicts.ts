import { expect } from "@std/expect";
import type { Result } from "#shared/result.ts";

/** Two writers raced for one slug: exactly one wins, and the loser is told the
 *  slug is taken. Shared by the site-page and news-post slug-write tests. */
export const expectOneSlugConflict = <T>(
  results: Result<T, "notFound" | "slugTaken">[],
): void => {
  expect(results.filter((result) => result.ok).length).toBe(1);
  expect(results.filter((result) => !result.ok)).toEqual([
    { error: "slugTaken", ok: false },
  ]);
};
