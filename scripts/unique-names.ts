/** One schema for every checked-in list of names that must be filled in and
 * unique: the required-checks manifest, the spec registry's tag lists. */

import * as v from "valibot";

/** A list of names with no blank entry and no duplicate. An entry is
 * trimmed first, so stray whitespace reads as formatting, not as a
 * different name. The message names the list, so a finding says which list
 * repeated a name. */
export const uniqueNamesSchema = (
  listName: string,
): v.GenericSchema<unknown, string[]> =>
  v.pipe(
    v.array(v.pipe(v.string(), v.trim(), v.nonEmpty())),
    v.check(
      (names) => new Set(names).size === names.length,
      `${listName} list a name twice`,
    ),
  );
