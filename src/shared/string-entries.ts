/** Keep entries whose values can be sent as strings. */
export const stringEntries = <Key>(
  entries: Iterable<readonly [Key, unknown]>,
): [Key, string][] =>
  Array.from(entries).flatMap(([key, value]) =>
    typeof value === "string" ? [[key, value]] : [],
  );
