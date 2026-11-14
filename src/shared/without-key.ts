/** Copy an object without one key. */
export const withoutKey =
  <Key extends PropertyKey>(key: Key) =>
  <T extends Record<Key, unknown>>(value: T): Omit<T, Key> => {
    const { [key]: _dropped, ...rest } = value;
    return rest;
  };
