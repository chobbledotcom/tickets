/**
 * The pure declaration of a typed table: its columns, the keys the user may
 * reference in a configurable layout, and the layout parser/validator bound
 * to those keys.
 *
 * No rendering lives here — `renderTable` (in `#templates/components/table.tsx`)
 * takes a `TableDefinition` and produces the JSX. This keeps the table's
 * shape — header, cell, key, Raw value — pure data, so `src/shared/db/settings.ts`
 * and other non-UI code can parse/validate a saved layout without importing
 * any JSX.
 */

import type { ReorderColumnOptions, TableColumn } from "#shared/tables/column.ts";
import type { TableLayout } from "#shared/tables/layout.ts";
import {
  buildDefaultTemplate,
  parseLayout,
  validateLayout,
} from "#shared/tables/layout.ts";

export type { ReorderColumnOptions, TableColumn };

/** A typed table's declaration: columns, configurable keys, and the layout
 *  helpers bound to those keys. Produced by {@link defineTable}. */
export type TableDefinition<TRow, TContext = void> = {
  /** The full column set, in declared order. */
  readonly columns: readonly TableColumn<TRow, TContext>[];
  /** Column key → column definition lookup. */
  readonly columnMap: ReadonlyMap<string, TableColumn<TRow, TContext>>;
  /** The default column keys to render, in order. Subset of `keys`. */
  readonly defaultColumnKeys: readonly string[];
  /** Every key the user may reference in a configurable layout — the union
   *  of `defaultColumnKeys` and any extras. The layout parser rejects any
   *  key outside this set. */
  readonly keys: readonly string[];
  /** `{{key}}, {{key}}` form of `defaultColumnKeys`, shown in the column-order
   *  settings form and the guide. */
  readonly defaultTemplate: string;
  /** The layout used when no user template is saved (or an empty one is). */
  readonly defaultLayout: TableLayout;
  /** Parse a saved Liquid template into a layout, falling back to
   *  {@link defaultLayout} when the template is empty. Throws on an invalid
   *  template so a corruption surfaces loudly. */
  parse: (template: string) => TableLayout;
  /** Validate a Liquid template, returning the error string or `null` when
   *  valid (or empty). */
  validate: (template: string) => string | null;
};

export type TableDefinitionOptions = {
  /** The default column keys to render, in order. Defaults to every column's
   *  key in declared order. */
  readonly defaultColumnKeys?: readonly string[];
  /** The keys the user may include in a configurable layout. Defaults to
   *  `defaultColumnKeys` (or every column key). Set this when the user may
   *  pick columns that don't appear by default — the listing table's extras
   *  (date, location, price, renewal). */
  readonly configKeys?: readonly string[];
};

const buildColumnMap = <TRow, TContext>(
  columns: readonly TableColumn<TRow, TContext>[],
): ReadonlyMap<string, TableColumn<TRow, TContext>> => {
  const map = new Map<string, TableColumn<TRow, TContext>>();
  for (const column of columns) {
    if (map.has(column.key)) {
      throw new Error(`defineTable: duplicate column key "${column.key}"`);
    }
    map.set(column.key, column);
  }
  return map;
};

/** Build a typed table definition from a column list + options. Pure: no
 *  JSX, no rows — the result is metadata plus a parse/validate pair bound to
 *  the table's keys. */
export const defineTable = <TRow, TContext = void>(
  columns: readonly TableColumn<TRow, TContext>[],
  options?: TableDefinitionOptions,
): TableDefinition<TRow, TContext> => {
  if (columns.length === 0) {
    throw new Error("defineTable: columns cannot be empty");
  }
  const columnMap = buildColumnMap(columns);
  const declaredKeys = columns.map((c) => c.key);
  const configKeys = options?.configKeys ?? declaredKeys;
  const defaultColumnKeys = options?.defaultColumnKeys ?? configKeys;

  // Reject any config/default key that isn't in the column set, so a
  // typo can't silently make a column disappear from the layout.
  for (const key of configKeys) {
    if (!columnMap.has(key)) {
      throw new Error(
        `defineTable: config key "${key}" is not a column (have ${declaredKeys.join(", ")})`,
      );
    }
  }
  for (const key of defaultColumnKeys) {
    if (!columnMap.has(key)) {
      throw new Error(
        `defineTable: default key "${key}" is not a column (have ${declaredKeys.join(", ")})`,
      );
    }
  }

  const defaultTemplate = buildDefaultTemplate(defaultColumnKeys);
  const defaultLayout: TableLayout = {
    columnKeys: defaultColumnKeys,
    filters: new Map(),
  };

  return {
    columnMap,
    columns,
    defaultColumnKeys,
    defaultLayout,
    defaultTemplate,
    keys: configKeys,
    parse: (template: string): TableLayout =>
      parseLayout(template, configKeys, defaultLayout),
    validate: (template: string): string | null =>
      validateLayout(template, configKeys),
  };
};

/** Look up a column by key, throwing loudly if it isn't in the table's set.
 *  Used by the renderer and by tests that exercise a saved layout. */
export const columnOrThrow = <TRow, TContext>(
  table: TableDefinition<TRow, TContext>,
  key: string,
): TableColumn<TRow, TContext> => {
  const column = table.columnMap.get(key);
  if (column === undefined) {
    throw new Error(
      `Column "${key}" is not in the table's set (have ${[...table.columnMap.keys()].join(", ")})`,
    );
  }
  return column;
};
