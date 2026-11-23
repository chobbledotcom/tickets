// effects: pure
/** Read a map entry from data that can arrive broken, such as an uploaded file
 * or a live database. The message says what is wrong with that data. A bug in
 * the code uses `requiredMapValue` from `#fp` instead. */
export const requiredMapValueWithMessage = <Key, Value>(
  values: ReadonlyMap<Key, Value>,
  key: Key,
  errorMessage: string,
): Value => {
  const value = values.get(key);
  if (value === undefined) throw new Error(errorMessage);
  return value;
};
