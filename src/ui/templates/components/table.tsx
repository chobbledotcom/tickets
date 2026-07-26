/**
 * Render typed table definitions through the shared scrolling table shell.
 * The renderer resolves requested and hidden columns, passes table context to
 * each cell and attaches cell and row attributes.
 *
 * Unknown requested keys fail at the table definition boundary. Cell renderers
 * return JSX children, so text is escaped unless the caller supplies `Raw`.
 */

/* jscpd:ignore-start */
import { filter, map } from "#fp";
import { t } from "#i18n";
import { isReadOnly } from "#shared/env.ts";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import type {
  ReorderColumnOptions,
  TableAttrs,
  TableColumn,
} from "#shared/tables/column.ts";
import type { TableDefinition } from "#shared/tables/definition.ts";
import { columnOrThrow, defineTable } from "#shared/tables/definition.ts";
import { ReorderArrows } from "#templates/components/reorder.tsx";
import {
  type ColumnKind,
  colClass,
} from "#templates/components/table-columns.ts";
import { renderFilteredValue } from "#templates/components/table-filters.ts";

/* jscpd:ignore-end */

type TableRenderShell<TRow, TContext> = {
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
};

type TableRenderFrame<TRow, TContext, TKey extends string> = TableRenderShell<
  TRow,
  TContext
> & {
  /** Saved Liquid expressions keyed by configurable column key. */
  readonly filters?: ReadonlyMap<TKey, string> | undefined;
  /** Add the standard move-up/down column when the site is writable. */
  readonly reorder?: ReorderColumnOptions<TRow> | undefined;
};

type TableContextOptions<TContext> = [TContext] extends [undefined]
  ? { readonly context?: undefined }
  : { readonly context: TContext };

/** Per-render options for column selection, context, row state, and framing. */
type TableRenderOptions<TRow, TContext, TKey extends string> = TableRenderFrame<
  TRow,
  TContext,
  TKey
> & {
  /** The column keys to render, in order. Defaults to the table's declared
   *  columns. Pass a parsed layout's keys to honour a configured order. */
  readonly columnKeys?: readonly TKey[] | undefined;
  /** Column keys that should NOT render even when listed in `columnKeys`.
   *  The attendee table uses this to hide columns whose data is entirely
   *  absent in the visible rows (e.g. email when no attendee has one). */
  readonly hiddenKeys?: ReadonlySet<TKey> | undefined;
} & TableContextOptions<TContext>;

/** Combine a column's class kind (e.g. "amount"), a column's free-form
 *  className (e.g. "actions-col"), and a cell's own class attribute (from
 *  `cellAttrs`) into one class string for the <td> or <th>. Returns the
 *  empty string for an all-empty input so the renderer can emit no class
 *  attribute at all. */
const combineClasses = (
  kind: ColumnKind | undefined,
  ...names: readonly (string | number | boolean | undefined)[]
): string =>
  [kind === undefined ? undefined : colClass(kind), ...names]
    .filter((name): name is string => typeof name === "string" && name !== "")
    .join(" ");

type TranslatedColumnText = {
  description: () => string;
  header: () => Child;
  label: () => string;
};

type TableColumnText = (
  key: string,
  headerKey?: string,
) => TranslatedColumnText;

/** Bind one table's translation prefix to its column metadata. */
export const tableColumnText =
  (prefix: string): TableColumnText =>
  (key, headerKey) => {
    const label = (): string => t(`${prefix}.${key}.label`);
    return {
      description: (): string => t(`${prefix}.${key}.description`),
      header:
        headerKey === undefined
          ? label
          : (): string => t(`${prefix}.${key}.${headerKey}`),
      label,
    };
  };

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

const TableCell = <TRow, TContext, TKey extends string>({
  column,
  row,
  ctx,
  index,
  rows,
  filter,
}: {
  column: TableColumn<TRow, TContext, TKey>;
  row: TRow;
  ctx: TContext;
  index: number;
  rows: readonly TRow[];
  filter: string | undefined;
}): JSX.Element => {
  const attrs = splitCellAttrs(column.cellAttrs?.(row, ctx));
  const className = combineClasses(column.class, column.className, attrs.class);
  const content =
    filter !== undefined && column.rawValue !== undefined
      ? renderFilteredValue(filter, column.rawValue(row, ctx), column.key)
      : column.cell(row, ctx, index, rows);
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

const headerCell = <TRow, TContext, TKey extends string>(
  column: TableColumn<TRow, TContext, TKey>,
): JSX.Element => {
  const header = resolveColumnText(column.header);
  const className = combineClasses(column.class, column.headerClassName);
  return className === "" ? (
    <th>{header}</th>
  ) : (
    <th class={className}>{header}</th>
  );
};

/** Build the column list to actually render: from `columnKeys` (or the
 *  table's default), minus any hidden keys. Validates that each requested
 *  key is in the table's set so a misconfiguration surfaces loudly. */
const resolveColumns = <TRow, TContext, TKey extends string>(
  table: TableDefinition<TRow, TContext, TKey>,
  columnKeys: readonly TKey[] | undefined,
  hiddenKeys: ReadonlySet<TKey> | undefined,
): readonly TableColumn<TRow, TContext, TKey>[] => {
  const columns =
    columnKeys === undefined
      ? table.columns
      : map((key: TKey) => columnOrThrow(table, key))(columnKeys);
  return filter(
    (column: TableColumn<TRow, TContext, TKey>) => !hiddenKeys?.has(column.key),
  )(columns);
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
  const dataColumns: {
    column: TableColumn<TRow, TContext>;
    filter: string | undefined;
  }[] = map((column: TableColumn<TRow, TContext, TKey>) => ({
    column,
    filter: options.filters?.get(column.key),
  }))(columns);
  const renderedColumns =
    reorder === undefined
      ? dataColumns
      : [{ column: reorder, filter: undefined }, ...dataColumns];
  const body: Child =
    rows.length === 0 && options.empty !== undefined ? (
      <tr>
        <td colspan={renderedColumns.length}>{options.empty}</td>
      </tr>
    ) : (
      rows.map((row, index) => (
        <tr {...(options.rowAttrs?.(row, ctx) ?? {})}>
          {renderedColumns.map(({ column, filter }) => (
            <TableCell
              column={column}
              ctx={ctx}
              filter={filter}
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
          <tr>{renderedColumns.map(({ column }) => headerCell(column))}</tr>
        </thead>
        <tbody {...(options.bodyAttrs ?? {})}>{body}</tbody>
        {options.foot !== undefined && <tfoot>{options.foot}</tfoot>}
      </table>
    </div>
  );
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
const reorderColumn = <TRow, TContext = undefined>(
  options: ReorderColumnOptions<TRow>,
): TableColumn<TRow, TContext> => ({
  cell: (row, _ctx, index, rows) => (
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
type ColumnReferenceSource = {
  readonly columns: readonly Pick<
    TableColumn<never, never>,
    "description" | "key" | "label"
  >[];
};

type ColumnReferenceRow = {
  readonly description: string;
  readonly key: string;
  readonly label: string;
};

const columnReferenceTable = defineTable<ColumnReferenceRow>([
  {
    cell: (row) => <code>{`{{${row.key}}}`}</code>,
    header: () => t("guide.table_reference.tag"),
    key: "tag",
  },
  {
    cell: (row) => row.label,
    header: () => t("guide.table_reference.label"),
    key: "label",
  },
  {
    cell: (row) => row.description,
    header: () => t("guide.table_reference.description"),
    key: "description",
  },
]);

export const renderColumnReference = (
  table: ColumnReferenceSource,
): JSX.Element => {
  const rows = table.columns.flatMap((column) => {
    const label = resolveGuideText(column.label);
    const description = resolveGuideText(column.description);
    return label === undefined || description === undefined
      ? []
      : [{ description, key: column.key, label }];
  });
  return renderTable(columnReferenceTable, rows);
};
