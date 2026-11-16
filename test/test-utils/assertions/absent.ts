/** Negative substring assertions: the one implementation behind every test
 *  that names what a body of text or a list of names must not show. */

import { assert } from "@std/assert";

/** Assert that `absent` occurs nowhere in `text`, which is either a body of
 *  text or a list of names. The failure names the needle that did occur, so a
 *  page that starts leaking a hidden link fails on that link. */
export const expectExcludesAll = (
  text: string | readonly string[],
  absent: readonly string[],
): void => {
  const haystack: readonly string[] = typeof text === "string" ? [text] : text;
  for (const needle of absent) {
    assert(!haystack.includes(needle), `Expected no occurrence of ${needle}`);
  }
};
