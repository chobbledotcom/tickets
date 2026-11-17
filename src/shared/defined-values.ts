// effects: pure
/** An object built from a list, without the entries whose value is missing. */

/** The value that `valueFor` gives each item, under the key that `keyOf` gives
 *  it. An item whose value is undefined adds no key. */
export const definedValuesBy = <Item>(
  items: readonly Item[],
  keyOf: (item: Item) => string,
  valueFor: (item: Item) => unknown,
): Record<string, unknown> =>
  Object.fromEntries(
    items.flatMap((item) => {
      const value = valueFor(item);
      return value === undefined ? [] : [[keyOf(item), value]];
    }),
  );
