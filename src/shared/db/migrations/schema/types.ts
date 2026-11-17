/** Types for the declarative database schema. */

import type { SqlStatement } from "#db/sql.ts";

declare const STORED: unique symbol;

/** A column's type in SQL, and the value a stored row holds in that column. */
export type ColumnKind<Stored> = SqlStatement & {
  readonly [STORED]: Stored;
};

export type Column = readonly [name: string, type: SqlStatement];

export type Index = {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique?: boolean;
  /** A fixed schema predicate for a partial index. */
  readonly where?: SqlStatement;
};

export type Table = {
  readonly columns: readonly Column[];
  readonly indexes?: readonly Index[];
};

/** One declared table: its name, then its columns and indexes. */
export type NamedTable = readonly [name: string, table: Table];

/** The declared tables, in the order the migrations create them. */
export type Schema = readonly NamedTable[];

/** The tables as the code writes them. The type keeps the name of each table
 *  and the name and the type of each column, so a read can know its row. */
export const declaredTables = <const Tables extends Schema>(
  tables: Tables,
): Tables => tables;

/**
 * A SQLite trigger that maintains or validates stored data. Unlike indexes,
 * triggers are not part of a single table's definition, so they live in their
 * own list. `table` is the table
 * the trigger fires ON — used to re-create the trigger after that table is
 * rebuilt by {@link recreateTable}, which silently drops attached triggers.
 * `sql` is the full idempotent `CREATE TRIGGER IF NOT EXISTS …` statement.
 */
export type Trigger = {
  name: string;
  table: string;
  sql: SqlStatement;
  /** Tables and columns this trigger reads or writes. */
  uses: Readonly<Record<string, readonly string[]>>;
};
