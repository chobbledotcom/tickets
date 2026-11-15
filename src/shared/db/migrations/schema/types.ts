/** Types for the declarative database schema. */

import type { SqlStatement } from "#db/sql.ts";

export type Column = [name: string, type: SqlStatement];

export type Index = {
  name: string;
  columns: string[];
  unique?: boolean;
  /** A fixed schema predicate for a partial index. */
  where?: SqlStatement;
};

export type Table = {
  columns: Column[];
  indexes?: Index[];
};

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
