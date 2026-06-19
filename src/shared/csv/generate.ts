/**
 * Generic CSV generator: turn an array of typed objects into CSV text given an
 * ordered list of column keys. The keys both fix the column order and become
 * the header row, and every row is validated against them so a column list that
 * drifts out of sync with the data raises an error instead of silently dropping
 * or misaligning values.
 *
 * Values are plain strings — callers format dates, currency, booleans, etc.
 * before handing rows over, which keeps this utility free of any domain or
 * locale knowledge and trivially testable.
 */

import { escapeCsvValue, joinCsvRows } from "#shared/csv/core.ts";

/** An object whose every property is a ready-to-write CSV string cell. */
export type CsvRow = Record<string, string>;

/**
 * Build one CSV line for a row, validating that the row's keys are exactly the
 * requested columns (no missing, no extra) before emitting the escaped values
 * in column order.
 */
const buildRow = <T extends CsvRow>(
  row: T,
  keys: readonly (keyof T & string)[],
): string => {
  if (Object.keys(row).length !== keys.length) {
    throw new Error(
      `toCsv: row keys [${Object.keys(row).join(
        ", ",
      )}] do not match columns [${keys.join(", ")}]`,
    );
  }
  return keys
    .map((key) => {
      const cell = row[key];
      if (cell === undefined) {
        throw new Error(`toCsv: row is missing column "${key}"`);
      }
      return escapeCsvValue(cell);
    })
    .join(",");
};

/**
 * Generate CSV text from typed row objects and an ordered list of column keys.
 * Throws when no columns are given, when the keys contain duplicates, or when
 * any row's keys do not match the columns exactly.
 */
export const toCsv = <T extends CsvRow>(
  rows: readonly T[],
  keys: readonly (keyof T & string)[],
): string => {
  if (keys.length === 0) {
    throw new Error("toCsv: at least one column key is required");
  }
  if (new Set(keys).size !== keys.length) {
    throw new Error(`toCsv: duplicate column keys: ${keys.join(", ")}`);
  }
  const header = keys.map(escapeCsvValue).join(",");
  return joinCsvRows(
    header,
    rows.map((row) => buildRow(row, keys)),
  );
};
