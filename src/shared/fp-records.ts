// effects: pure
/**
 * Small curried helpers that make or reshape one value: kept out of `fp.ts`
 * so that file stays under the file-length budget.
 */

/** A function that always throws an error with `message`. */
export const refusalOf = (message: string) => (): never => {
  throw new Error(message);
};

/** A copy of a record with one key left out. */
export const withoutKey =
  <Key extends string>(key: Key) =>
  <Row extends Record<Key, unknown>>(row: Row): Omit<Row, Key> => {
    const { [key]: _dropped, ...rest } = row;
    return rest;
  };

/** A copy of a record with every key of a set left out. */
export const withoutKeys =
  (keys: ReadonlySet<string>) =>
  (row: object): Record<string, unknown> =>
    Object.fromEntries(Object.entries(row).filter(([key]) => !keys.has(key)));

/** The ids of the items, as a set to test membership against. */
export const idSet = <Id>(items: Iterable<{ readonly id: Id }>): Set<Id> =>
  new Set(Array.from(items, (item) => item.id));
