/** Require every aligned lookup result and name all keys that were missing. */
export const requireFound = <Key, Value>(
  keys: readonly Key[],
  values: readonly (Value | null)[],
  label: string,
): Value[] => {
  const missing = keys.filter((_key, index) => values[index] === null);
  if (missing.length > 0) {
    throw new Error(`Required ${label} do not exist: ${missing.join(", ")}`);
  }
  return values as Value[];
};
