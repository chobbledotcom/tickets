/**
 * A pure CSV system. It knows nothing about attendees, listings, or the wider
 * application — only how to turn a list of items plus an ordered set of columns
 * into RFC 4180 CSV text. Callers describe each column with a header and a
 * function that reads its cell from an item, then call {@link CSV.generate}.
 */

/** A CSV column: its header and how to read a cell from a source item. */
export type Column<T> = {
  header: string;
  value: (item: T) => string;
};

/** Escape one value for CSV (commas, quotes, newlines, carriage returns). */
const escapeValue = (value: string): string =>
  /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

/** Join a header line with already-built data rows. No trailing newline, built
 * in a single pass. */
const joinRows = (header: string, rows: readonly string[]): string =>
  rows.length === 0 ? header : `${header}\n${rows.join("\n")}`;

/**
 * Build CSV text from items and the columns that describe them. The headers and
 * every cell are escaped. Throws only when no columns are given — duplicate
 * headers are allowed (e.g. two custom questions sharing a name), matching what
 * spreadsheets accept.
 */
const generate = <T>(
  items: readonly T[],
  columns: readonly Column<T>[],
): string => {
  if (columns.length === 0) {
    throw new Error("CSV.generate: at least one column is required");
  }
  return joinRows(
    columns.map((c) => escapeValue(c.header)).join(","),
    items.map((item) =>
      columns.map((c) => escapeValue(c.value(item))).join(","),
    ),
  );
};

/** The pure CSV system. */
export const CSV = { escape: escapeValue, generate, join: joinRows };
