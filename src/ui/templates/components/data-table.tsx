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

/* jscpd:ignore-start */
import { t } from "#i18n";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import {
  type ColumnKind,
  colClass,
} from "#templates/components/table-columns.ts";
/* jscpd:ignore-end */

export type Column = {
  /** The <th> content. */
  header: Child;
  /** A column-kind class (e.g. `"amount"`, `"quantity"`, `"reorder"`,
   *  `"actions"`) applied to both this column's <th> and every <td> in it. */
  class?: ColumnKind;
};

/** A class-less table column that is just a translated header. Shared by the
 *  admin list tables so the plain `{ header: t(key) }` column stops being
 *  repeated (and reading as duplicated) at each call site. */
export const textCol = (headerKey: string): Column => ({
  header: t(headerKey),
});

/** Build plain (class-less) text columns from i18n header keys — the common
 *  all-text header row. Collapses the repeated `{ header: t(key) }` object at
 *  each call site into one call, which also keeps similar header rows across
 *  tables from reading as duplicated column literals. */
const textColumns = (...headerKeys: string[]): Column[] =>
  headerKeys.map(textCol);

/** The name column every admin list table leads with. */
const NAME_HEADER_KEY = "common.name";

/** Text columns for an admin list table that leads with the shared Name
 *  column, then the given text columns. Keeps that leading name column in one
 *  place instead of repeating it at every table. */
export const namedColumns = (...headerKeys: string[]): Column[] =>
  textColumns(NAME_HEADER_KEY, ...headerKeys);

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
    <div
      class={
        scrollClass === undefined
          ? "table-scroll"
          : `table-scroll ${scrollClass}`
      }
    >
      <table class={tableClass}>
        <thead>
          <tr>
            {columns.map((c) =>
              c.class === undefined ? (
                <th>{c.header}</th>
              ) : (
                <th class={colClass(c.class)}>{c.header}</th>
              ),
            )}
          </tr>
        </thead>
        <tbody {...bodyAttrs}>{body}</tbody>
        {foot !== undefined && <tfoot>{foot}</tfoot>}
      </table>
    </div>
  );
};

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

/** An admin collection body: the shared "nothing yet" paragraph when the list
 *  is empty, otherwise a {@link DataTable}. Every admin list page (groups,
 *  modifiers, …) shows this same empty-or-table, so it lives here once. */
export const CollectionTable = <T,>({
  items,
  emptyKey,
  columns,
  rows,
}: {
  items: readonly T[];
  emptyKey: string;
  columns: Column[];
  rows: DataTableProps["rows"];
}): JSX.Element =>
  items.length === 0 ? (
    <p>{t(emptyKey)}</p>
  ) : (
    <DataTable columns={columns} rows={rows} />
  );
