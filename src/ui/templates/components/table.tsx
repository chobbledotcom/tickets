/**
 * Render typed table definitions through the shared scrolling table shell.
 * The renderer resolves requested and hidden columns, passes table context to
 * each cell and attaches cell and row attributes.
 *
 * Unknown requested keys fail at the table definition boundary. Cell renderers
 * return JSX children, so text is escaped unless the caller supplies `Raw`.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { isReadOnly } from "#shared/env.ts";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import type {
  ReorderColumnOptions,
  TableAttrs,
  TableColumn,
} from "#shared/tables/column.ts";
import type { TableDefinition } from "#shared/tables/definition.ts";
import { columnOrThrow } from "#shared/tables/definition.ts";
import { ReorderArrows } from "#templates/components/reorder.tsx";
import {
  type ColumnKind,
  colClass,
} from "#templates/components/table-columns.ts";

/* jscpd:ignore-end */

type TableRenderShell<TRow, TContext = void> = {
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
  /** Attributes attached to each rendered data row. */
  readonly rowAttrs?:
    | ((row: TRow, context: TContext) => TableAttrs)
    | undefined;
  /** Optional cell renderer installed by configurable tables. */
  readonly renderCell?: TableCellRenderer<TRow, TContext> | undefined;
};

type TableContextOptions<TContext> = [undefined] extends [TContext]
  ? { readonly context?: undefined }
  : { readonly context: TContext };

export type TableCellRenderer<TRow, TContext> = (
  column: TableColumn<TRow, TContext>,
  row: TRow,
  context: TContext,
  index: number,
  rows: readonly TRow[],
) => Child;

/** Per-render options for column selection, context, row state, and framing. */
export type TableRenderOptions<TRow, TContext = void> = TableRenderShell<
  TRow,
  TContext
> & {
  /** The column keys to render, in order. Defaults to the table's
   *  layout defaults. Pass the parsed layout's `columnKeys` to honour a
   *  user-configured order. */
  readonly columnKeys?: readonly string[] | undefined;
  /** Column keys that should NOT render even when listed in `columnKeys`.
   *  The attendee table uses this to hide columns whose data is entirely
   *  absent in the visible rows (e.g. email when no attendee has one). */
  readonly hiddenKeys?: ReadonlySet<string> | undefined;
  /** Add the standard move-up/down column when the site is writable. */
  readonly reorder?: ReorderColumnOptions<TRow> | undefined;
} & TableContextOptions<TContext>;

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

/** Build the translated text shared by a table column's header and guide row. */
export const tableColumnText = (
  label: () => string,
  description: () => string,
  header: () => Child = label,
): { description: () => string; header: () => Child; label: () => string } => ({
  description,
  header,
  label,
});

const resolveColumnText = (text: Child | (() => Child)): Child =>
  typeof text === "function" ? text() : text;

const resolveGuideText = (
  text: string | (() => string) | undefined,
): string | undefined => (typeof text === "function" ? text() : text);

/** Split `cellAttrs` into the cell-level class (merged with the column kind's
 *  class) and the remaining attributes. */
const splitCellAttrs = (
  attrs: TableAttrs | undefined,
): { class: string | number | boolean | undefined; rest: TableAttrs } => {
  if (attrs === undefined) return { class: undefined, rest: {} };
  const { class: customClass, ...rest } = attrs;
  return { class: customClass, rest };
};

/** The shared scrolling table shell wrapping one header, body, and footer. */
const TableShell = ({
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
  renderCell,
}: {
  column: TableColumn<TRow, TContext>;
  row: TRow;
  ctx: TContext;
  index: number;
  rows: readonly TRow[];
  renderCell: TableCellRenderer<TRow, TContext> | undefined;
}): JSX.Element => {
  const attrs = splitCellAttrs(column.cellAttrs?.(row, ctx));
  const className = combineClasses(column.class, column.className, attrs.class);
  const content =
    renderCell === undefined
      ? column.cell(row, ctx, index, rows)
      : renderCell(column, row, ctx, index, rows);
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
const renderHeaderCell = (header: Child, className: string): JSX.Element =>
  className === "" ? <th>{header}</th> : <th class={className}>{header}</th>;

const headerCell = <TRow, TContext>(
  column: TableColumn<TRow, TContext>,
): JSX.Element =>
  renderHeaderCell(
    resolveColumnText(column.header),
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
  const requested = columnKeys ?? table.layout.defaultColumnKeys;
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
  options: TableRenderOptions<TRow, TContext> | undefined,
): readonly TableColumn<TRow, TContext>[] => {
  const columns = resolveColumns(
    table,
    options?.columnKeys,
    options?.hiddenKeys,
  );
  return options?.reorder === undefined || isReadOnly()
    ? columns
    : [reorderColumn<TRow, TContext>(options.reorder), ...columns];
};

type InternalRenderOptions<TRow, TContext> = TableRenderShell<
  TRow,
  TContext
> & {
  readonly columns: readonly TableColumn<TRow, TContext>[];
  readonly context: TContext;
};

/** Render the table from a fixed column list, rows, and framing options. */
const renderColumns = <TRow, TContext = void>(
  rows: readonly TRow[],
  options: InternalRenderOptions<TRow, TContext>,
): JSX.Element => {
  const { columns } = options;
  const colCount = columns.length;
  const ctx = options.context;

  const body: Child =
    rows.length === 0 && options.empty !== undefined ? (
      <tr>
        <td colspan={colCount}>{options.empty}</td>
      </tr>
    ) : (
      rows.map((row, index) => (
        <tr {...(options.rowAttrs?.(row, ctx) ?? {})}>
          {columns.map((column) => (
            <TableCell
              column={column}
              ctx={ctx}
              index={index}
              renderCell={options.renderCell}
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

/** Build renderer-internal options with the resolved column list. */
const renderColumnsOptions = <TRow, TContext>(
  options: TableRenderOptions<TRow, TContext> | undefined,
  columns: readonly TableColumn<TRow, TContext>[],
): InternalRenderOptions<TRow, TContext> => ({
  bodyAttrs: options?.bodyAttrs,
  columns,
  context: (options?.context ?? undefined) as TContext,
  empty: options?.empty,
  foot: options?.foot,
  renderCell: options?.renderCell,
  rowAttrs: options?.rowAttrs,
  scrollClass: options?.scrollClass,
  tableClass: options?.tableClass,
});

/** Render the table from its definition + rows + options. Returns the full
 *  `<div class="table-scroll"><table>…</table></div>` shell. */
export const renderTable = <TRow, TContext = void>(
  table: TableDefinition<TRow, TContext>,
  rows: readonly TRow[],
  ...optionArgs: [undefined] extends [TContext]
    ? [options?: TableRenderOptions<TRow, TContext>]
    : [options: TableRenderOptions<TRow, TContext>]
): JSX.Element => {
  const options = optionArgs[0];
  return renderColumns(
    rows,
    renderColumnsOptions(options, resolveOptionColumns(table, options)),
  );
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

/** Convenience: render the column-reference table shown in the admin guide.
 *  The same `<div class="table-scroll"><table>` shell as every other table,
 *  with one row per column showing its `{{key}}` tag, label, and description. */
export const renderColumnReference = <TRow, TContext>(
  table: TableDefinition<TRow, TContext>,
): JSX.Element => {
  const rows = table.columns.flatMap((column) => {
    const label = resolveGuideText(column.label);
    const description = resolveGuideText(column.description);
    return label === undefined || description === undefined
      ? []
      : [
          <tr>
            <td>
              <code>{`{{${column.key}}}`}</code>
            </td>
            <td>{label}</td>
            <td>{description}</td>
          </tr>,
        ];
  });
  return (
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>{t("guide.table_reference.tag")}</th>
            <th>{t("guide.table_reference.label")}</th>
            <th>{t("guide.table_reference.description")}</th>
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
};
