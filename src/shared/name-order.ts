/** Ordering for records that carry a name. */

/** The named records, ordered by name in ascending locale order, without
 * changing the input. */
export const sortByName = <T extends { name: string }>(
  rows: readonly T[],
): T[] => rows.toSorted(compareByName);

/** Compare two named rows by name, ascending. One comparator for every sort
 * that falls back to the name. */
export const compareByName = <T extends { name: string }>(
  first: T,
  second: T,
): number => first.name.localeCompare(second.name);
