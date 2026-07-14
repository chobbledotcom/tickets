/** Types for the declarative database schema. */

export type Column = [name: string, type: string];

export type Index = {
  name: string;
  columns: string[];
  unique?: boolean;
};

export type Table = {
  columns: Column[];
  indexes?: Index[];
};

/**
 * A SQLite trigger that maintains a precomputed aggregate. Unlike indexes,
 * triggers aren't part of a single table's definition (they fire on one table
 * and write to another), so they live in their own list. `table` is the table
 * the trigger fires ON — used to re-create the trigger after that table is
 * rebuilt by {@link recreateTable}, which silently drops attached triggers.
 * `sql` is the full idempotent `CREATE TRIGGER IF NOT EXISTS …` statement.
 */
export type Trigger = {
  /** Every table/column the trigger reads or writes. Trigger sync waits until
   * all are live, so an earlier migration cannot install a trigger whose body
   * refers to a table or column a later migration has not added yet. */
  dependencies?: Record<string, readonly string[]>;
  name: string;
  table: string;
  sql: string;
};
