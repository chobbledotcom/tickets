/**
 * The pure declaration of a typed table: its columns, the keys the user may
 * reference in a configurable layout, and the one pure layout definition
 * attached to those renderers.
 *
 * No rendering lives here — `renderTable` (in `#templates/components/table.tsx`)
 * takes a `TableDefinition` and produces the JSX. This keeps the table's
 * shape — header, cell, key, Raw value — pure data, so `src/shared/db/settings.ts`
 * and other non-UI code can parse/validate a saved layout without importing
 * any JSX.
 */

import type {
  ReorderColumnOptions,
  TableColumn,
} from "#shared/tables/column.ts";
import {
  defineTableLayout,
  type TableLayoutDefinition,
} from "#shared/tables/layout.ts";

export type { ReorderColumnOptions, TableColumn };

type TableColumns<TRow, TContext, TKey extends string> = readonly TableColumn<
  TRow,
  TContext,
  TKey
>[];

type TableParts<TRow, TContext, TKey extends string> = {
  readonly columns: TableColumns<TRow, TContext, TKey>;
  readonly layout: TableLayoutDefinition<TKey>;
};

/** A typed table's declaration: columns, configurable keys, and the layout
 *  helpers bound to those keys. Produced by {@link defineTable}. */
export type TableDefinition<
  TRow,
  TContext = void,
  TKey extends string = string,
> = {
  /** The full column set, in declared order. */
  readonly columns: TableColumns<TRow, TContext, TKey>;
  /** Column key → column definition lookup. */
  readonly columnMap: ReadonlyMap<TKey, TableColumn<TRow, TContext, TKey>>;
  /** The pure key/default/parser contract shared with non-UI settings code. */
  readonly layout: TableLayoutDefinition<TKey>;
};

const buildColumnMap = <TRow, TContext, TKey extends string>(
  columns: TableColumns<TRow, TContext, TKey>,
): ReadonlyMap<TKey, TableColumn<TRow, TContext, TKey>> => {
  const map = new Map<TKey, TableColumn<TRow, TContext, TKey>>();
  for (const column of columns) {
    map.set(column.key, column);
  }
  return map;
};

/** Build a typed table definition from a column list + options. Pure: no
 *  JSX, no rows — the result is metadata plus a parse/validate pair bound to
 *  the table's keys. */
const buildTable = <TRow, TContext, TKey extends string>({
  columns,
  layout,
}: TableParts<TRow, TContext, TKey>): TableDefinition<TRow, TContext, TKey> => {
  if (columns.length === 0) {
    throw new Error("defineTable: columns cannot be empty");
  }
  const columnMap = buildColumnMap(columns);
  return { columnMap, columns, layout };
};

/** Build an ordinary fixed table whose declared order is its only layout. */
export const defineTable = <
  TRow,
  TContext = void,
  TKey extends string = string,
>(
  columns: TableColumns<TRow, TContext, TKey>,
): TableDefinition<TRow, TContext, TKey> => {
  const keys = columns.map((column) => column.key);
  return buildTable({
    columns,
    layout: defineTableLayout({ options: keys }, keys),
  });
};

type ColumnRenderer<TRow, TContext, TKey extends string> = Omit<
  TableColumn<TRow, TContext, TKey>,
  "key"
>;

/** Attach one exhaustive renderer record to an existing pure layout. */
export const attachTableRenderers = <TRow, TContext, TKey extends string>(
  layout: TableLayoutDefinition<TKey>,
  renderers: Readonly<Record<TKey, ColumnRenderer<TRow, TContext, TKey>>>,
): TableDefinition<TRow, TContext, TKey> => {
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
  return buildTable({ columns, layout });
};

/** Look up a column by key, throwing loudly if it isn't in the table's set.
 *  Used by the renderer and by tests that exercise a saved layout. */
export const columnOrThrow = <TRow, TContext, TKey extends string>(
  table: TableDefinition<TRow, TContext, TKey>,
  key: TKey,
): TableColumn<TRow, TContext, TKey> => {
  const column = table.columnMap.get(key);
  if (column === undefined) {
    throw new Error(
      `Column "${key}" is not in the table's set (have ${[...table.columnMap.keys()].join(", ")})`,
    );
  }
  return column;
};
