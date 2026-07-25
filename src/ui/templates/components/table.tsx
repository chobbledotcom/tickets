/**
 * The one rectangular-table renderer: turns a {@link TableDefinition} plus
 * rows + options into the scrolling `<div class="table-scroll"><table>` shell
 * every admin list page renders from. Header cells, body cells, the column
 * class, the per-cell attributes, the empty-state row, and the optional
 * `<tfoot>` all live here.
 *
 * Columns are looked up by key against the table definition, so a column
 * that's missing from `columnKeys` is a clear error rather than a silent
 * off-by-one between the header row and the body. Cells return JSX children
 * — never raw HTML strings — so escaping is automatic and the old
 * `isHtml` flag and `escapeHtml` trust protocol are gone.
 */

import { isReadOnly } from "#shared/env.ts";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import type {
  CellAttrs,
  ReorderColumnOptions,
  TableColumn,
} from "#shared/tables/column.ts";
import type { TableDefinition } from "#shared/tables/definition.ts";
import { columnOrThrow } from "#shared/tables/definition.ts";
import { renderFilteredValue } from "#shared/tables/liquid.ts";
import {
  ReorderArrows,
  type ReorderProps,
} from "#templates/components/reorder.tsx";
import {
  type ColumnKind,
  colClass,
} from "#templates/components/table-columns.ts";

export type { ColumnKind, ReorderColumnOptions, TableColumn, TableDefinition };

/** Per-render options for `renderTable` and `renderReorderTable`. All
 *  optional — the table definition carries the columns. Pass these to
 *  override the default column order, hide specific columns, pass a
 *  per-table context to cells, or attach empty state, foot, scroll/table
 *  class, or body attributes. */
export type TableRenderOptions<TContext = void> = {
  /** The column keys to render, in order. Defaults to the table's
   *  `defaultColumnKeys`. Pass the parsed layout's `columnKeys` to honour a
   *  user-configured order. */
  readonly columnKeys?: readonly string[] | undefined;
  /** Per-table context passed to every column's `cell` and `cellAttrs`. */
  readonly context?: TContext | undefined;
  /** Per-column-key Liquid filter expressions, applied to a column's
   *  `rawValue` instead of its `cell()` output. Pass the parsed layout's
   *  `filters`. */
  readonly filters?: ReadonlyMap<string, string> | undefined;
  /** Column keys that should NOT render even when listed in `columnKeys`.
   *  The attendee table uses this to hide columns whose data is entirely
   *  absent in the visible rows (e.g. email when no attendee has one). */
  readonly hiddenKeys?: ReadonlySet<string> | undefined;
  /** Empty-state body rendered in a single `<td colspan>` when rows is
   *  empty. When omitted, an empty rows array renders no body at all. */
  readonly empty?: Child | undefined;
  /** Optional `<tfoot>` content (e.g. a totals row). */
  readonly foot?: Child | undefined;
  /** Extra class on the table-scroll wrapper. */
  readonly scrollClass?: string | undefined;
  /** Extra class on the <table> element (e.g. "availability-table"). */
  readonly tableClass?: string | undefined;
  /** Attributes on the <tbody> element. */
  readonly bodyAttrs?: Record<string, string> | undefined;
};

/** Convert one part to its CSS class contribution, or `undefined` when it
 *  contributes nothing (boolean false, empty string, or a numeric/boolean
 *  cell-attr value the caller is just passing through). */
const partToClass = (
  part: ColumnKind | string | number | boolean | undefined,
): string | undefined => {
  if (part === undefined || part === false || part === null) return;
  if (typeof part === "string") return part === "" ? undefined : part;
  if (typeof part === "number" || typeof part === "boolean") return;
  return colClass(part);
};

/** Combine a column's class kind (e.g. "amount"), a column's free-form
 *  className (e.g. "actions-col"), and a cell's own class attribute (from
 *  `cellAttrs`) into one class string for the <td> or <th>. Returns the
 *  empty string for an all-empty input so the renderer can emit no class
 *  attribute at all. */
const combineClasses = (
  ...parts: readonly (ColumnKind | string | number | boolean | undefined)[]
): string =>
  parts
    .map(partToClass)
    .filter((c): c is string => c !== undefined)
    .join(" ");

/** Split `cellAttrs` into the cell-level class (merged with the column kind's
 *  class) and the remaining attributes. */
const splitCellAttrs = (
  attrs: CellAttrs | undefined,
): { class: string | number | boolean | undefined; rest: CellAttrs } => {
  if (attrs === undefined) return { class: undefined, rest: {} };
  const { class: customClass, ...rest } = attrs;
  return { class: customClass, rest };
};

/** Render one <td>'s body. When a Liquid filter is active and the column
 *  exposes a raw value, the filter runs against that value (escaped); the
 *  column's own `cell()` is otherwise the body. */
const cellContent = <TRow, TContext>(
  column: TableColumn<TRow, TContext>,
  row: TRow,
  ctx: TContext,
  index: number,
  rows: readonly TRow[],
  filterExpr: string | undefined,
): Child => {
  if (filterExpr && column.rawValue) {
    return renderFilteredValue(
      filterExpr,
      column.rawValue(row, ctx),
      column.key,
    );
  }
  return column.cell(row, ctx, index, rows);
};

/** Render a single <td> for one column + row. */
const TableCell = <TRow, TContext>({
  column,
  row,
  ctx,
  index,
  rows,
  filterExpr,
}: {
  column: TableColumn<TRow, TContext>;
  row: TRow;
  ctx: TContext;
  index: number;
  rows: readonly TRow[];
  filterExpr: string | undefined;
}): JSX.Element => {
  const attrs = splitCellAttrs(column.cellAttrs?.(row, ctx));
  const className = combineClasses(column.class, column.className, attrs.class);
  const content = cellContent(column, row, ctx, index, rows, filterExpr);
  return className === "" ? (
    <td {...attrs.rest}>{content}</td>
  ) : (
    <td class={className} {...attrs.rest}>
      {content}
    </td>
  );
};

const headerCell = <TRow, TContext>(
  column: TableColumn<TRow, TContext>,
): JSX.Element => {
  const className = combineClasses(column.class, column.className);
  return className === "" ? (
    <th>{column.header}</th>
  ) : (
    <th class={className}>{column.header}</th>
  );
};

/** Build the column list to actually render: from `columnKeys` (or the
 *  table's default), minus any hidden keys. Validates that each requested
 *  key is in the table's set so a misconfiguration surfaces loudly. */
const resolveColumns = <TRow, TContext>(
  table: TableDefinition<TRow, TContext>,
  columnKeys: readonly string[] | undefined,
  hiddenKeys: ReadonlySet<string> | undefined,
): readonly TableColumn<TRow, TContext>[] => {
  const requested = columnKeys ?? table.defaultColumnKeys;
  const result: TableColumn<TRow, TContext>[] = [];
  for (const key of requested) {
    if (hiddenKeys?.has(key)) continue;
    result.push(columnOrThrow(table, key));
  }
  return result;
};

type InternalRenderOptions<TRow, TContext> = {
  readonly columns: readonly TableColumn<TRow, TContext>[];
  readonly context?: TContext | undefined;
  readonly filters?: ReadonlyMap<string, string> | undefined;
  readonly empty?: Child | undefined;
  readonly foot?: Child | undefined;
  readonly scrollClass?: string | undefined;
  readonly tableClass?: string | undefined;
  readonly bodyAttrs?: Record<string, string> | undefined;
};

/** Render the table from a fixed column list + rows + options. The shared
 *  interior of `renderTable` and `renderReorderTable`. */
const renderColumns = <TRow, TContext = void>(
  rows: readonly TRow[],
  options: InternalRenderOptions<TRow, TContext>,
): JSX.Element => {
  const { columns } = options;
  const colCount = columns.length;
  // `void` accepts `undefined` (no context passed); contextual tables pass
  // their own context. `as TContext` because the option's `?` admits
  // `undefined`, which is exactly what `void` callers leave absent.
  const ctx = (options.context ?? undefined) as TContext;
  const filters = options.filters ?? new Map<string, string>();

  const body: Child =
    rows.length === 0 && options.empty !== undefined ? (
      <tr>
        <td colspan={colCount}>{options.empty}</td>
      </tr>
    ) : (
      rows.map((row, index) => (
        <tr>
          {columns.map((column) => (
            <TableCell
              column={column}
              ctx={ctx}
              filterExpr={filters.get(column.key)}
              index={index}
              row={row}
              rows={rows}
            />
          ))}
        </tr>
      ))
    );

  return (
    <div
      class={
        options.scrollClass === undefined
          ? "table-scroll"
          : `table-scroll ${options.scrollClass}`
      }
    >
      <table class={options.tableClass}>
        <thead>
          <tr>{columns.map(headerCell)}</tr>
        </thead>
        <tbody {...(options.bodyAttrs ?? {})}>{body}</tbody>
        {options.foot !== undefined && <tfoot>{options.foot}</tfoot>}
      </table>
    </div>
  );
};

/** Render the table from its definition + rows + options. Returns the full
 *  `<div class="table-scroll"><table>…</table></div>` shell. */
export const renderTable = <TRow, TContext = void>(
  table: TableDefinition<TRow, TContext>,
  rows: readonly TRow[],
  options?: TableRenderOptions<TContext>,
): JSX.Element => {
  const columns = resolveColumns(
    table,
    options?.columnKeys,
    options?.hiddenKeys,
  );
  return renderColumns(rows, {
    bodyAttrs: options?.bodyAttrs,
    columns,
    context: options?.context,
    empty: options?.empty,
    filters: options?.filters,
    foot: options?.foot,
    scrollClass: options?.scrollClass,
    tableClass: options?.tableClass,
  });
};

/** The standard up/down reorder-arrows column: prepended to a table's
 *  columns when the operator can re-order rows. Hidden entirely in
 *  read-only mode (the arrows would post to a route that 403s). */
export const reorderColumn = <TRow, TContext = void>(
  options: ReorderColumnOptions<TRow>,
): TableColumn<TRow, TContext> => ({
  cell: (row, _ctx, index, rows) =>
    isReadOnly() ? null : (
      <ReorderArrows
        action={options.action(row)}
        count={rows.length}
        index={index}
        {...(options.titles === undefined ? {} : { titles: options.titles })}
      />
    ),
  class: "reorder",
  header: options.header,
  key: "__reorder__",
});

/** Render a table with its reorder column prepended (when not read-only). */
export const renderReorderTable = <TRow, TContext = void>(
  table: TableDefinition<TRow, TContext>,
  reorder: ReorderColumnOptions<TRow>,
  rows: readonly TRow[],
  options?: TableRenderOptions<TContext>,
): JSX.Element => {
  const baseColumns = resolveColumns(
    table,
    options?.columnKeys,
    options?.hiddenKeys,
  );
  const columns = isReadOnly()
    ? baseColumns
    : [reorderColumn<TRow, TContext>(reorder), ...baseColumns];
  return renderColumns(rows, {
    bodyAttrs: options?.bodyAttrs,
    columns,
    context: options?.context,
    empty: options?.empty,
    filters: options?.filters,
    foot: options?.foot,
    scrollClass: options?.scrollClass,
    tableClass: options?.tableClass,
  });
};

/** Convenience: render the column-reference table shown in the admin guide.
 *  The same `<div class="table-scroll"><table>` shell as every other table,
 *  with one row per column showing its `{{key}}` tag, label, and description. */
export const renderColumnReference = <TRow, TContext>(
  table: TableDefinition<TRow, TContext>,
): JSX.Element => {
  const rows = table.columns
    .filter(
      (
        c,
      ): c is TableColumn<TRow, TContext> & {
        label: string;
        description: string;
      } => c.label !== undefined && c.description !== undefined,
    )
    .map((c) => (
      <tr>
        <td>
          <code>{`{{${c.key}}}`}</code>
        </td>
        <td>{c.label}</td>
        <td>{c.description}</td>
      </tr>
    ));
  return (
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Tag</th>
            <th>Label</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
};

export type { ReorderProps };
