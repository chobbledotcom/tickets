// effects: pure
/**
 * Columns that a read written by hand picks by name. The builder does not
 * write some reads, for example a read with a CTE or a UNION. The client decodes each
 * picked column through its codec, as it does for a builder read.
 */

import { pick } from "@std/collections";
import { tableNode } from "#db/select/query.ts";
import { withSources } from "#db/select/sources.ts";
import type { TableHandle, TableName } from "#db/select/tables.ts";
import { type SqlStatement, sql, sqlCommas, sqlName } from "#db/sql.ts";

/** The picked columns of a hand-written read. */
export type PickedColumns = Readonly<{
  /** The SELECT list: each column under its name. */
  list: SqlStatement;
  /** Mark the read that selects `list`, so the client decodes its rows. */
  decoded: <Statement extends SqlStatement>(statement: Statement) => Statement;
}>;

/** Pick each column under its name. Take each column from `tableNode`, so
 *  that it names its table. */
export const pickedColumns = (
  picked: Readonly<Record<string, SqlStatement>>,
): PickedColumns => {
  const entries = Object.entries(picked);
  return {
    decoded: (statement) => withSources(statement, entries),
    list: sqlCommas(
      entries.map(([name, value]) => sql`${value} AS ${sqlName(name)}`),
    ),
  };
};

/** Every column of `table` under `word`, for a hand-written read of whole rows
 *  with values worked out beside them. */
export const everyColumnPicked = (
  table: TableHandle<TableName>,
  word: string,
): PickedColumns => {
  const node: Readonly<Record<string, SqlStatement>> = tableNode(table, word);
  return pickedColumns(
    Object.fromEntries(
      table.columns.map(([column]) => [column, node[column]!]),
    ),
  );
};

/** The columns of a builder read that these keys of its node name. */
export const columnsNamed =
  <Key extends string>(keys: readonly Key[]) =>
  <Node extends Record<Key, unknown>>(node: Node): Pick<Node, Key> =>
    pick(node, keys);
