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
