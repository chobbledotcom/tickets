/**
 * A consistent admin data table: <div class="table-scroll"><table> with
 * declared columns and a body of <tr> rows.
 *
 * Every admin list page renders data through this so the scroll wrapper,
 * thead/tbody structure, column classes, and empty-state handling are uniform
 * across the admin. Declare each column's header (and optional `colClass` —
 * one of {@link ColumnKind}, applied to both that column's <th> and every
 * <td> in it), then pass the body rows. Each row is an array of body cells
 * (positional to its column), an array of pre-rendered <tr> JSX elements
 * (for callers whose row helper returns a full <tr>), or a pre-rendered
 * HTML string for callers with their own renderRow() helper.
 */

import { t } from "#i18n";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { Raw, SafeHtml } from "#shared/jsx/jsx-runtime.ts";
import {
  type ColumnKind,
  colClass,
} from "#templates/components/table-columns.ts";

export type Column = {
  /** The <th> content. */
  header: Child;
  /** A column-kind class (e.g. `"amount"`, `"quantity"`, `"reorder"`,
   *  `"actions"`) applied to both this column's <th> and every <td> in it. */
  class?: ColumnKind;
};

/** Build plain (class-less) text columns from i18n header keys — the common
 *  all-text header row. Collapses the repeated `{ header: t(key) }` object at
 *  each call site into one call, which also keeps similar header rows across
 *  tables from reading as duplicated column literals. */
export const textColumns = (...headerKeys: string[]): Column[] =>
  headerKeys.map((key) => ({ header: t(key) }));

export type DataTableProps = {
  /** Column declarations (header + optional class). */
  columns: Column[];
  /** Either an array of rows (each row = array of body cells, positional to
   *  its column, rendered as <tr><td>cell</td>...</tr> with the column's
   *  class applied), an array of pre-rendered <tr> JSX elements (rendered
   *  as-is — caller is responsible for cell classes), or a pre-rendered
   *  HTML string rendered via <Raw> for callers with their own
   *  renderRow() helper. */
  rows: Child[][] | string | JSX.Element[];
  /** Optional `<tfoot>` content (e.g. a totals row). Rendered after the body
   *  with the same column-width expectations. */
  foot?: Child;
  /** Extra class on the table-scroll wrapper (e.g. "dashboard-holidays-scroll"
   *  for callers that need bespoke scroll styling). */
  scrollClass?: string | undefined;
  /** Extra class on the <table> element itself (e.g. "availability-table"). */
  tableClass?: string | undefined;
  /** Attributes on the <tbody> element (e.g. `{"data-duplicate-preview-rows": true}`
   *  for the bulk-actions duplicate-preview table's JS hook). */
  bodyAttrs?: Record<string, string> | undefined;
};

const isCellRows = (rows: DataTableProps["rows"]): rows is Child[][] =>
  Array.isArray(rows) && (rows.length === 0 || Array.isArray(rows[0]));

/**
 * The scrollable admin-table shell: the `table-scroll` wrapper, the table, a
 * single `<thead>` header row holding `head`, and the body rows. {@link DataTable}
 * builds on this, and bespoke tables that assemble their own header/body cells
 * (rather than the {@link Column} model) share this same outer scaffold through
 * it, so there is one home for the wrapper/thead/tbody structure.
 */
export const ScrollTable = ({
  head,
  children,
  scrollClass,
  tableClass,
  bodyAttrs,
  foot,
}: {
  head: Child;
  children: Child;
  scrollClass?: string | undefined;
  tableClass?: string | undefined;
  bodyAttrs?: Record<string, string> | undefined;
  foot?: Child;
}): JSX.Element => (
  <div
    class={
      scrollClass === undefined ? "table-scroll" : `table-scroll ${scrollClass}`
    }
  >
    <table class={tableClass}>
      <thead>
        <tr>{head}</tr>
      </thead>
      <tbody {...bodyAttrs}>{children}</tbody>
      {foot !== undefined && <tfoot>{foot}</tfoot>}
    </table>
  </div>
);

export const DataTable = ({
  columns,
  rows,
  foot,
  scrollClass,
  tableClass,
  bodyAttrs,
}: DataTableProps): JSX.Element => {
  const body =
    typeof rows === "string" ? (
      <Raw html={rows} />
    ) : isCellRows(rows) ? (
      rows.map((row) => (
        <tr>
          {row.map((cell, i) => {
            const kind = columns[i]?.class;
            return kind === undefined ? (
              <td>{cell}</td>
            ) : (
              <td class={colClass(kind)}>{cell}</td>
            );
          })}
        </tr>
      ))
    ) : (
      rows
    );
  return (
    <ScrollTable
      bodyAttrs={bodyAttrs}
      foot={foot}
      head={columns.map((c) =>
        c.class === undefined ? (
          <th>{c.header}</th>
        ) : (
          <th class={colClass(c.class)}>{c.header}</th>
        ),
      )}
      scrollClass={scrollClass}
      tableClass={tableClass}
    >
      {body}
    </ScrollTable>
  );
};

/**
 * A {@link DataTable} that shows a short note in place of the table when there
 * are no rows — the common "list page, or an empty message" shape. Pass
 * `emphasiseEmpty` to wrap the note in `<em>` for the softer "nothing built
 * yet" pages.
 */
export const DataTableOrEmpty = ({
  columns,
  rows,
  emptyText,
  emphasiseEmpty,
}: {
  columns: Column[];
  rows: Child[][];
  emptyText: Child;
  emphasiseEmpty?: boolean;
}): JSX.Element =>
  rows.length === 0 ? (
    <p>{emphasiseEmpty ? <em>{emptyText}</em> : emptyText}</p>
  ) : (
    <DataTable columns={columns} rows={rows} />
  );

/**
 * A heading above a data table, shown only when there are rows to list. When
 * `rows` is empty it renders nothing, so a caller can drop in an optional
 * section without writing the "only when there's something to show" guard and
 * the surrounding fragment itself.
 */
export const TableSection = ({
  heading,
  columns,
  rows,
}: {
  heading: Child;
  columns: Column[];
  rows: Child[][];
}): JSX.Element =>
  rows.length > 0 ? (
    <>
      <h2>{heading}</h2>
      <DataTable columns={columns} rows={rows} />
    </>
  ) : (
    new SafeHtml("")
  );

/**
 * A typed table column: its header, optional column-kind class, and a cell
 * renderer that produces one <td>'s content from the row it belongs to.
 * Pair {@link dataTable} so a caller declares each column's header and cell
 * once — the column order can't drift from the cell order, and the column's
 * class lives next to its renderer. */
export type DataColumn<TRow> = {
  header: Child;
  class?: ColumnKind;
  cell: (row: TRow, index: number, rows: readonly TRow[]) => Child;
};

/**
 * Curried typed table builder. Declare the columns once (header + optional
 * column-kind class + a cell renderer); the returned function takes the rows
 * and renders a {@link DataTable}, mapping each row to its cells in declared
 * order. The column order is declared once and shared by header and body, so
 * a column can't be mis-ordered between `columns` and `rows.map`.
 *
 * Pass the optional second arg straight through to {@link DataTableProps} for
 * scrollClass/tableClass/bodyAttrs. */
export const dataTable =
  <TRow,>(columns: readonly DataColumn<TRow>[]) =>
  (
    rows: readonly TRow[],
    options?: {
      scrollClass?: string;
      tableClass?: string;
      bodyAttrs?: Record<string, string>;
      foot?: Child;
    },
  ): JSX.Element => (
    <DataTable
      bodyAttrs={options?.bodyAttrs}
      columns={[...columns]}
      foot={options?.foot}
      rows={rows.map((row, index) =>
        columns.map((column) => column.cell(row, index, rows)),
      )}
      scrollClass={options?.scrollClass}
      tableClass={options?.tableClass}
    />
  );
