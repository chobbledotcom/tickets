/** Page-body omissions: assert a rendered body carries none of the named
 *  fragments. The negative half of `expectIncludesAll`. */

import { assert } from "@std/assert";

/** Assert no fragment appears in `text`; returns the text for further
 *  checks. */
export const expectOmitsAll = (text: string, fragments: string[]): string => {
  for (const fragment of fragments) assert(!text.includes(fragment));
  return text;
};
