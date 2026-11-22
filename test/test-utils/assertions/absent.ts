/** Negative substring assertions: the one implementation behind every test
 *  that names what a body of text or a list of names must not show. */

import { assert } from "@std/assert";

/** Assert that `absent` occurs nowhere in `text`, which is either a body of
 *  text or a list of names. For a string, the check is a substring search;
 *  for a list, an exact match. The failure names the needle that did occur,
 *  so a page that starts leaking a hidden link fails on that link. */
export const expectExcludesAll = (
  text: string | readonly string[],
  absent: readonly string[],
): void => {
  for (const needle of absent) {
    assert(!text.includes(needle), `Expected no occurrence of ${needle}`);
  }
};
