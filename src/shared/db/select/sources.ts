// effects: pure
/**
 * The declared column behind each value that a read gives. The client decodes
 * a value that comes straight from a column through that column's codec. A
 * value worked out from a column is not decoded.
 */

import type { InStatement } from "@libsql/client";
import type { SqlStatement } from "#db/sql.ts";

/** A column of a declared table. */
export type Source = Readonly<{ table: string; column: string }>;

const columnSources = new WeakMap<SqlStatement, Source>();

const readSources = new WeakMap<
  object,
  readonly (readonly [string, Source])[]
>();

/** Mark SQL as the column `source`. */
export const fromColumn = <Statement extends SqlStatement>(
  statement: Statement,
  source: Source,
): Statement => {
  columnSources.set(statement, source);
  return statement;
};

/** Mark a read with the column behind each name it gives. A value that no
 *  column is behind gets no mark. */
export const withSources = <Statement extends SqlStatement>(
  statement: Statement,
  picked: readonly (readonly [string, SqlStatement])[],
): Statement => {
  const sources = picked.flatMap(([name, value]) => {
    const source = columnSources.get(value);
    return source === undefined ? [] : [[name, source] as const];
  });
  if (sources.length > 0) readSources.set(statement, sources);
  return statement;
};

/** The column behind each name a statement gives. A statement that the
 *  builder did not write, or a read of worked-out values, has none. */
export const sourcesOf = (
  statement: InStatement,
): readonly (readonly [string, Source])[] =>
  typeof statement === "string" ? [] : (readSources.get(statement) ?? []);

/** Mark a statement whose rows are the named columns of `table`, such as a
 *  write that returns the rows it wrote. */
export const withColumnsOf = <Statement extends SqlStatement>(
  statement: Statement,
  table: string,
  columns: readonly string[],
): Statement => {
  readSources.set(
    statement,
    columns.map((column) => [column, { column, table }] as const),
  );
  return statement;
};
