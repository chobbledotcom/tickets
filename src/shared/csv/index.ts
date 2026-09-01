/**
 * A pure CSV system. It knows nothing about attendees, listings, or the wider
 * application — only how to turn a list of items plus an ordered set of columns
 * into RFC 4180 CSV text whose cells cannot run as spreadsheet formulas.
 * Callers describe each column with a header and a function that reads its
 * cell from an item, then call {@link CSV.generate}.
 */

/** A CSV column: its header and how to read a cell from a source item. */
export type Column<T> = {
  header: string;
  value: (item: T) => string;
};

/** The characters OWASP lists as formula starters: the four visible ones,
 * tab, CR, LF, and the full-width forms a Japanese locale accepts. Tab is
 * listed there as a caution for import paths, yet a quoted tab is also the
 * page's neutralizer — see {@link stopFormula} and {@link escapeValue}. */
const FORMULA_START = /^[=+\-@\t\r\n＝＋－＠]/;

/** Stop a spreadsheet from running a cell as a formula: a tab in front makes
 * the text inert, and Excel keeps a data tab when a saved file is opened
 * again — it can strip a quote or escape marker instead. */
const stopFormula = (value: string): string =>
  FORMULA_START.test(value) ? `\t${value}` : value;

/** Escape one value for CSV (commas, quotes, newlines, carriage returns).
 * A tab marker is wrapped as well, so a tab-delimited import cannot split
 * the marker off the formula it guards. */
const escapeValue = (value: string): string =>
  value.startsWith("\t") || /[",\n\r]/.test(value)
    ? `"${value.replace(/"/g, '""')}"`
    : value;

/** Join a header line with already-built data rows. No trailing newline, built
 * in a single pass. */
const joinRows = (header: string, rows: readonly string[]): string =>
  rows.length === 0 ? header : `${header}\n${rows.join("\n")}`;

/**
 * Build CSV text from items and the columns that describe them. The headers
 * and every cell are escaped, and a value that starts like a spreadsheet
 * formula gets a quoted tab in front so no app runs it. Throws only when no
 * columns are given — duplicate headers are allowed (e.g. two custom
 * questions sharing a name), matching what spreadsheets accept.
 */
const generate = <T>(
  items: readonly T[],
  columns: readonly Column<T>[],
): string => {
  if (columns.length === 0) {
    throw new Error("CSV.generate: at least one column is required");
  }
  return joinRows(
    columns.map((c) => escapeValue(stopFormula(c.header))).join(","),
    items.map((item) =>
      columns.map((c) => escapeValue(stopFormula(c.value(item)))).join(","),
    ),
  );
};

/** The pure CSV system. */
export const CSV = { generate };
