/** How a check counts what it found: once per key, as a plain record. */

/** Count the items of every collection by the key `keyOf` reads from each.
 * The tally is a Map, so a key such as "constructor" or "__proto__" counts
 * like any other word instead of meeting a built-in object property. */
export const countBy =
  <Item>(keyOf: (item: Item) => string) =>
  (items: readonly Item[]): Record<string, number> => {
    const counts = new Map<string, number>();
    for (const item of items) {
      const key = keyOf(item);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Object.fromEntries(counts);
  };
