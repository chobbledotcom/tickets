/** Helpers for tests that pin generated SQL statements. */

import { isSqlStatement } from "#db/sql.ts";

/** How many times `needle` appears in `haystack`. */
export const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

/** Collapse whitespace runs so layout can change without breaking snapshots. */
export const flatSql = (sql: string): string => sql.replace(/\s+/g, " ").trim();

/** The same value with each statement in it shown as its SQL text. A statement
 * that binds values shows its text and its values. */
export const sqlText = (value: unknown): unknown => {
  if (isSqlStatement(value)) {
    return value.args.length === 0
      ? value.sql
      : { args: value.args, sql: value.sql };
  }
  if (Array.isArray(value)) return value.map(sqlText);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, sqlText(inner)]),
    );
  }
  return value;
};

/** A statement read place by place: one `?` and one value for each place a
 * value is written. A value that shares a slot shows once for each place. */
export const placed = (statement: {
  readonly args: readonly unknown[];
  readonly sql: string;
}): { args: unknown[]; sql: string } => {
  const args: unknown[] = [];
  const text = statement.sql.replaceAll(/\?(\d+)/g, (_slot, number) => {
    args.push(statement.args[Number(number) - 1]);
    return "?";
  });
  return { args, sql: text };
};
