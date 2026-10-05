/** Ordering for records that carry a name. */

/** The named records, ordered by name in ascending locale order, without
 * changing the input. */
export const sortByName = <T extends { name: string }>(
  rows: readonly T[],
): T[] => rows.toSorted((a, b) => a.name.localeCompare(b.name));
