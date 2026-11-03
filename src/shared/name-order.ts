/** Ordering for records that carry a name. */

/** The named records, in the order `compare` picks, without changing the
 * input. Name order is the default. */
export const sortByName = <T extends { name: string }>(
  rows: readonly T[],
  compare: (first: T, second: T) => number = compareByName,
): T[] => rows.toSorted(compare);

/** Compare two named rows by name, ascending. One comparator for every sort
 * that falls back to the name. */
export const compareByName = <T extends { name: string }>(
  first: T,
  second: T,
): number => first.name.localeCompare(second.name);
