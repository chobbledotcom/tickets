/** How a check counts what it found: once per key, as a plain record. */

/** Count the items of every collection by the key `keyOf` reads from each. */
export const countBy =
  <Item>(keyOf: (item: Item) => string) =>
  (items: readonly Item[]): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const item of items) {
      const key = keyOf(item);
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  };
