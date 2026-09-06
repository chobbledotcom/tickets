/** Helpers for tests that pin generated SQL statements. */

/** How many times `needle` appears in `haystack`. */
export const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

/** Collapse whitespace runs so layout can change without breaking snapshots. */
export const flatSql = (sql: string): string => sql.replace(/\s+/g, " ").trim();
