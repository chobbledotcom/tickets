/**
 * Map-building helpers — the `#fp` combinators that key rows into a Map.
 * Kept beside `fp.ts` (which imports nothing from here) so both stay under
 * the file-length budget.
 */

/**
 * Key items by their own id, so a caller can look one up. Hand-rolled because
 * `@std/collections.associateBy` keys by a string and gives back an object,
 * while every caller here has number ids and wants a Map.
 */
export const byId = <T extends { id: number }>(
  items: readonly T[],
): Map<number, T> => new Map(items.map((item) => [item.id, item]));

/** Key each row by one value and keep the value each row maps to. */
export const rowsToMap = <Row, Key, Value>(
  rows: readonly Row[],
  key: (row: Row) => Key,
  value: (row: Row) => Value,
): Map<Key, Value> => new Map(rows.map((row) => [key(row), value(row)]));
