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

type TableRenderShell<TRow, TContext, TKey extends string> = {
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
  readonly renderCell?: TableCellRenderer<TRow, TContext, TKey> | undefined;
};

type TableRenderFrame<TRow, TContext, TKey extends string> = TableRenderShell<
  TRow,
  TContext,
  TKey
> & {
  /** Add the standard move-up/down column when the site is writable. */
  readonly reorder?: ReorderColumnOptions<TRow> | undefined;
};

type TableContextOptions<TContext> = [TContext] extends [undefined]
  ? { readonly context?: undefined }
  : { readonly context: TContext };

export type TableCellRenderer<TRow, TContext, TKey extends string> = (
  column: TableColumn<TRow, TContext, TKey>,
  row: TRow,
  context: TContext,
  index: number,
  rows: readonly TRow[],
) => Child;

/** Per-render options for column selection, context, row state, and framing. */
export type TableRenderOptions<
  TRow,
  TContext,
  TKey extends string,
> = TableRenderFrame<TRow, TContext, TKey> & {
  /** The column keys to render, in order. Defaults to the table's
   *  layout defaults. Pass the parsed layout's `columnKeys` to honour a
   *  user-configured order. */
  readonly columnKeys?: readonly TKey[] | undefined;
  /** Column keys that should NOT render even when listed in `columnKeys`.
   *  The attendee table uses this to hide columns whose data is entirely
   *  absent in the visible rows (e.g. email when no attendee has one). */
  readonly hiddenKeys?: ReadonlySet<TKey> | undefined;
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
const combineClasses = (
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
const TableCell = <TRow, TContext, TKey extends string>({
  column,
  row,
  ctx,
  index,
  rows,
  renderCell,
}: {
  column: TableColumn<TRow, TContext, TKey>;
  row: TRow;
  ctx: TContext;
  index: number;
  rows: readonly TRow[];
  renderCell: TableCellRenderer<TRow, TContext, TKey> | undefined;
}): JSX.Element => {
  const attrs = splitCellAttrs(column.cellAttrs?.(row, ctx));
  const className = combineClasses(column.class, column.className, attrs.class);
  const content =
    renderCell === undefined
      ? column.cell(row, ctx, index, rows)
      : renderCell(column, row, ctx, index, rows);
  const cellAttrs =
    className === "" ? attrs.rest : { class: className, ...attrs.rest };
  return column.rowHeader ? (
    <th {...cellAttrs} scope="row">
      {content}
    </th>
  ) : (
    <td {...cellAttrs}>{content}</td>
  );
};

/** Render a th element with `header` content, applying `className` only
 *  when non-empty so the renderer can emit no class attribute at all.
 *  Lifted out so the positional-and-typed renderers share one shape; both
 *  call this so a `<th>` element's structure can never drift between them. */
const renderHeaderCell = (header: Child, className: string): JSX.Element =>
  className === "" ? <th>{header}</th> : <th class={className}>{header}</th>;

const headerCell = <TRow, TContext, TKey extends string>(
  column: TableColumn<TRow, TContext, TKey>,
): JSX.Element =>
  renderHeaderCell(
    resolveColumnText(column.header),
    combineClasses(column.class, column.headerClassName),
  );

/** Build the column list to actually render: from `columnKeys` (or the
 *  table's default), minus any hidden keys. Validates that each requested
 *  key is in the table's set so a misconfiguration surfaces loudly. */
const resolveColumns = <TRow, TContext, TKey extends string>(
  table: TableDefinition<TRow, TContext, TKey>,
  columnKeys: readonly TKey[] | undefined,
  hiddenKeys: ReadonlySet<TKey> | undefined,
): readonly TableColumn<TRow, TContext, TKey>[] => {
  const requested = columnKeys ?? table.layout.defaultColumnKeys;
  const result: TableColumn<TRow, TContext, TKey>[] = [];
  for (const key of requested) {
    if (hiddenKeys?.has(key)) continue;
    result.push(columnOrThrow(table, key));
  }
  return result;
};

/** Render the table from a fixed column list, rows, and framing options. */
const renderColumns = <TRow, TContext, TKey extends string>(
  rows: readonly TRow[],
  columns: readonly TableColumn<TRow, TContext, TKey>[],
  ctx: TContext,
  options: TableRenderFrame<TRow, TContext, TKey>,
): JSX.Element => {
  const reorder =
    options.reorder === undefined || isReadOnly()
      ? undefined
      : reorderColumn<TRow, TContext>(options.reorder);
  const colCount = columns.length + (reorder === undefined ? 0 : 1);
  const body: Child =
    rows.length === 0 && options.empty !== undefined ? (
      <tr>
        <td colspan={colCount}>{options.empty}</td>
      </tr>
    ) : (
      rows.map((row, index) => (
        <tr {...(options.rowAttrs?.(row, ctx) ?? {})}>
          {reorder !== undefined && (
            <TableCell
              column={reorder}
              ctx={ctx}
              index={index}
              renderCell={undefined}
              row={row}
              rows={rows}
            />
          )}
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
    headerRow: (
      <tr>
        {reorder !== undefined && headerCell(reorder)}
        {columns.map(headerCell)}
      </tr>
    ),
    scrollClass: options.scrollClass,
    tableClass: options.tableClass,
  });
};

/** Render the table from its definition + rows + options. Returns the full
 *  `<div class="table-scroll"><table>…</table></div>` shell. */
export const renderTable = <TRow, TKey extends string, TContext = undefined>(
  table: TableDefinition<TRow, TContext, TKey>,
  rows: readonly TRow[],
  ...optionArgs: [TContext] extends [undefined]
    ? [options?: TableRenderOptions<TRow, TContext, TKey>]
    : [options: TableRenderOptions<TRow, TContext, TKey>]
): JSX.Element => {
  const options = optionArgs[0];
  const columns = resolveColumns(
    table,
    options?.columnKeys,
    options?.hiddenKeys,
  );
  return renderColumns(
    rows,
    columns,
    (options?.context ?? undefined) as TContext,
    options ?? {},
  );
};

/** The standard up/down reorder-arrows column: prepended to a table's
 *  columns when the operator can re-order rows. Hidden entirely in
 *  read-only mode (the arrows would post to a route that 403s). */
export const reorderColumn = <TRow, TContext = undefined>(
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
type ColumnReferenceTable = {
  readonly columns: readonly Pick<
    TableColumn<never, never>,
    "description" | "key" | "label"
  >[];
};

export const renderColumnReference = (
  table: ColumnReferenceTable,
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
