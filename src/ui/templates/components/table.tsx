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

/** Render-only options that don't affect which columns appear. Shared by
 *  `renderTable` (which adds `columnKeys`/`hiddenKeys` column selection via
 *  {@link TableRenderOptions}) and `renderReorderTable` (which prepends a
 *  reorder column). Lifts the duplicated field list out so the renderers
 *  can't drift on which optional props they pass through. */
export type TableRenderShell<TContext = void> = {
  /** Per-table context passed to every column's `cell` and `cellAttrs`. */
  readonly context?: TContext | undefined;
  /** Per-column-key Liquid filter expressions, applied to a column's
   *  `rawValue` instead of its `cell()` output. Pass the parsed layout's
   *  `filters`. */
  readonly filters?: ReadonlyMap<string, string> | undefined;
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

/** Per-render options for `renderTable` and `renderReorderTable`. All
 *  optional — the table definition carries the columns. Pass these to
 *  override the default column order, hide specific columns, pass a
 *  per-table context to cells, or attach empty state, foot, scroll/table
 *  class, or body attributes. */
export type TableRenderOptions<TContext = void> = TableRenderShell<TContext> & {
  /** The column keys to render, in order. Defaults to the table's
   *  `defaultColumnKeys`. Pass the parsed layout's `columnKeys` to honour a
   *  user-configured order. */
  readonly columnKeys?: readonly string[] | undefined;
  /** Column keys that should NOT render even when listed in `columnKeys`.
   *  The attendee table uses this to hide columns whose data is entirely
   *  absent in the visible rows (e.g. email when no attendee has one). */
  readonly hiddenKeys?: ReadonlySet<string> | undefined;
};

/** The set of `ColumnKind` literal values, for runtime disambiguation between
 *  a `class` (ColumnKind — to be turned into `col-<kind>`) and a `className`
 *  (free-form string — used verbatim). Both are typed as `string` at runtime
 *  since `ColumnKind` is a string-literal union. */
const COLUMN_KINDS: ReadonlySet<string> = new Set([
  "reorder",
  "amount",
  "quantity",
  "actions",
]);

/** Convert one part to its CSS class contribution, or `undefined` when it
 *  contributes nothing (boolean false, empty string, or a numeric/boolean
 *  cell-attr value the caller is just passing through). A ColumnKind value
 *  ("amount", "quantity", etc.) maps to `col-amount`, `col-quantity`, and a
 *  free-form className string is used verbatim. */
const partToClass = (
  part: ColumnKind | string | number | boolean | undefined,
): string | undefined => {
  if (part === undefined || part === false || part === null) return;
  if (typeof part === "number" || typeof part === "boolean") return;
  if (part === "") return;
  return COLUMN_KINDS.has(part) ? colClass(part as ColumnKind) : part;
};

/** Combine a column's class kind (e.g. "amount"), a column's free-form
 *  className (e.g. "actions-col"), and a cell's own class attribute (from
 *  `cellAttrs`) into one class string for the <td> or <th>. Returns the
 *  empty string for an all-empty input so the renderer can emit no class
 *  attribute at all. */
export const combineClasses = (
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

/** The shared `<div class="table-scroll"><table>` shell wrapping one table's
 *  header row, body, and optional footer. Both the positional `DataTable`
 *  renderer (in `data-table.tsx`) and the typed `renderColumns` renderer
 *  call this so the wrapping structure can never drift between them. */
export const TableShell = ({
  body,
  bodyAttrs,
  foot,
  headerRow,
  scrollClass,
  tableClass,
}: {
  body: Child;
  bodyAttrs?: Record<string, string> | undefined;
  foot?: Child | undefined;
  headerRow: JSX.Element;
  scrollClass?: string | undefined;
  tableClass?: string | undefined;
}): JSX.Element => (
  <div
    class={
      scrollClass === undefined ? "table-scroll" : `table-scroll ${scrollClass}`
    }
  >
    <table class={tableClass}>
      <thead>{headerRow}</thead>
      <tbody {...(bodyAttrs ?? {})}>{body}</tbody>
      {foot !== undefined && <tfoot>{foot}</tfoot>}
    </table>
  </div>
);
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

/** Render a th element with `header` content, applying `className` only
 *  when non-empty so the renderer can emit no class attribute at all.
 *  Lifted out so the positional-and-typed renderers share one shape; both
 *  call this so a `<th>` element's structure can never drift between them. */
export const renderHeaderCell = (
  header: Child,
  className: string,
): JSX.Element =>
  className === "" ? <th>{header}</th> : <th class={className}>{header}</th>;

const headerCell = <TRow, TContext>(
  column: TableColumn<TRow, TContext>,
): JSX.Element =>
  renderHeaderCell(
    column.header,
    combineClasses(column.class, column.headerClassName),
  );

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

/** Wrap `resolveColumns` for the common `renderTable`/`renderReorderTable`
 *  case where the column-selection parameters come straight off the
 *  render-options object. */
const resolveOptionColumns = <TRow, TContext>(
  table: TableDefinition<TRow, TContext>,
  options: TableRenderOptions<TContext> | undefined,
): readonly TableColumn<TRow, TContext>[] =>
  resolveColumns(table, options?.columnKeys, options?.hiddenKeys);

type InternalRenderOptions<TRow, TContext> = TableRenderShell<TContext> & {
  readonly columns: readonly TableColumn<TRow, TContext>[];
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

  return TableShell({
    body,
    bodyAttrs: options.bodyAttrs,
    foot: options.foot,
    headerRow: <tr>{columns.map(headerCell)}</tr>,
    scrollClass: options.scrollClass,
    tableClass: options.tableClass,
  });
};

/** Build the renderer-internal options from the public render options by
 *  picking the shell fields and substituting the resolved column list. Used
 *  by both `renderTable` and `renderReorderTable` so they can't drift on
 *  which optional props they pass through. */
const renderColumnsOptions = <TRow, TContext>(
  options: TableRenderOptions<TContext> | undefined,
  columns: readonly TableColumn<TRow, TContext>[],
): InternalRenderOptions<TRow, TContext> => ({
  bodyAttrs: options?.bodyAttrs,
  columns,
  context: options?.context,
  empty: options?.empty,
  filters: options?.filters,
  foot: options?.foot,
  scrollClass: options?.scrollClass,
  tableClass: options?.tableClass,
});

/** Render the table from its definition + rows + options. Returns the full
 *  `<div class="table-scroll"><table>…</table></div>` shell. */
// jscpd:ignore-start — `table, rows, options` signature matches
// `renderReorderTable` below by necessity: both renderers take the same
// typed-table inputs plus their renderer-specific argument. There's nothing
// to merge between a function-mandated parameter list.
export const renderTable = <TRow, TContext = void>(
  table: TableDefinition<TRow, TContext>,
  rows: readonly TRow[],
  options?: TableRenderOptions<TContext>,
): JSX.Element =>
  renderColumns(
    rows,
    renderColumnsOptions(options, resolveOptionColumns(table, options)),
  );
// jscpd:ignore-end

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
  const baseColumns = resolveOptionColumns(table, options);
  const columns = isReadOnly()
    ? baseColumns
    : [reorderColumn<TRow, TContext>(reorder), ...baseColumns];
  return renderColumns(rows, renderColumnsOptions(options, columns));
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
