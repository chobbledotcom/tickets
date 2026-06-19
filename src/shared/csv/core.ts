/**
 * Low-level CSV primitives shared by every CSV generator: escaping a single
 * value and joining a header with its data rows. Kept tiny and dependency-free
 * so both the bespoke attendee/calendar generators and the generic
 * {@link file://./generate.ts toCsv} utility build on the exact same core.
 */

/**
 * Escape a value for CSV (handles commas, quotes, newlines, carriage returns).
 * A value containing any of those is wrapped in double quotes with internal
 * quotes doubled, per RFC 4180.
 */
export const escapeCsvValue = (value: string): string =>
  /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

/**
 * Join a header line with already-built data rows into CSV text. No trailing
 * newline is emitted, so a header with no rows is just the header. Uses a
 * single `Array.join` rather than incremental concatenation so output is built
 * in one efficient pass.
 */
export const joinCsvRows = (header: string, rows: readonly string[]): string =>
  rows.length === 0 ? header : `${header}\n${rows.join("\n")}`;
