/**
 * The pure declaration of a typed table: its columns and, for configurable
 * tables, the keys the user may reference in a saved layout.
 *
 * No rendering lives here — `renderTable` (in `#templates/components/table.tsx`)
 * takes a `TableDefinition` and produces the JSX. Configurable layouts stay
 * pure so settings code can parse them without importing any JSX.
 */

import type { TableColumn } from "#shared/tables/column.ts";
import type { TableLayoutDefinition } from "#shared/tables/layout.ts";

type TableColumns<TRow, TContext, TKey extends string> = readonly TableColumn<
  TRow,
  TContext,
  TKey
>[];

/** A typed table's declaration, produced by {@link defineTable}. */
export type TableDefinition<
  TRow,
  TContext = undefined,
  TKey extends string = string,
> = {
  /** The full column set, in declared order. */
  readonly columns: TableColumns<TRow, TContext, TKey>;
};

/** A table whose columns are bound to a saved-layout parser. */
export type ConfigurableTableDefinition<
  TRow,
  TContext = undefined,
  TKey extends string = string,
> = TableDefinition<TRow, TContext, TKey> & {
  /** The pure key/default/parser contract shared with non-UI settings code. */
  readonly layout: TableLayoutDefinition<TKey>;
};

const validateColumns = <TRow, TContext, TKey extends string>(
  columns: TableColumns<TRow, TContext, TKey>,
): void => {
  if (columns.length === 0) {
    throw new Error("defineTable: columns cannot be empty");
  }
  const keys = columns.map((column) => column.key);
  if (new Set(keys).size !== keys.length) {
    throw new Error("defineTable: column keys must be unique");
  }
};

/** Build an ordinary fixed table whose declared order is its only layout. */
export const defineTable = <
  TRow,
  TContext = undefined,
  TKey extends string = string,
>(
  columns: TableColumns<TRow, TContext, TKey>,
): TableDefinition<TRow, TContext, TKey> => {
  validateColumns(columns);
  return { columns };
};

type ColumnRenderer<TRow, TContext, TKey extends string> = Omit<
  TableColumn<TRow, TContext, TKey>,
  "key"
>;

/** Attach one exhaustive renderer record to an existing pure layout. */
export const attachTableRenderers = <TRow, TContext, TKey extends string>(
  layout: TableLayoutDefinition<TKey>,
  renderers: Readonly<Record<TKey, ColumnRenderer<TRow, TContext, TKey>>>,
): ConfigurableTableDefinition<TRow, TContext, TKey> => {
  const columns = layout.keys.map((key) => {
    const renderer = renderers[key];
    if (renderer === undefined) {
      throw new Error(`attachTableRenderers: key "${key}" has no renderer`);
    }
    return { ...renderer, key };
  });
  const extraKey = Object.keys(renderers).find(
    (key) => !layout.keys.includes(key as TKey),
  );
  if (extraKey !== undefined) {
    throw new Error(
      `attachTableRenderers: renderer key "${extraKey}" is not in the layout`,
    );
  }
  validateColumns(columns);
  return { columns, layout };
};

/** Look up a column by key, throwing loudly if it isn't in the table's set.
 *  Used by the renderer and by tests that exercise a saved layout. */
export const columnOrThrow = <TRow, TContext, TKey extends string>(
  table: TableDefinition<TRow, TContext, TKey>,
  key: TKey,
): TableColumn<TRow, TContext, TKey> => {
  const column = table.columns.find((candidate) => candidate.key === key);
  if (column === undefined) {
    throw new Error(
      `Column "${key}" is not in the table's set (have ${table.columns.map((candidate) => candidate.key).join(", ")})`,
    );
  }
  return column;
};
