/**
 * A consistent admin data table: `<div class="table-scroll"><table>` with
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
 *
 * For typed-table use (where cell renderers read from a row object), prefer
 * `defineTable` + `renderTable` from `#templates/components/table.tsx` —
 * the positional API here is for callers whose cells are already-rendered
 * JSX children.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { type ColumnKind } from "#templates/components/table-columns.ts";
import {
  combineClasses,
  renderHeaderCell,
  TableShell,
} from "#templates/components/table.tsx";

/* jscpd:ignore-end */

export type { ColumnKind };

export type Column = {
  /** The <th> content. */
  header: Child;
  /** A column-kind class (e.g. `"amount"`, `"quantity"`, `"reorder"`,
   *  `"actions"`) applied to both this column's <th> and every <td> in it. */
  class?: ColumnKind;
  /** A free-form class applied to both this column's <th> and every <td>
   *  in it (e.g. `"cell-description"`, `"actions-col"`). Combined with
   *  `class` when both are set. */
  className?: string;
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
  /** Column declarations (header + optional class/className). */
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

/** Combine a column's `class` (kind) and `className` (free-form) into one
 *  class string for the <th> or <td>; returns undefined when neither is set
 *  so the renderer can emit no class attribute at all. Delegates to the
 *  shared `combineClasses` so column-kind rules (`col-amount`, `col-quantity`,
 *  etc.) match the typed-table renderer's exactly. */
const cellClassName = (column: Column): string | undefined => {
  const combined = combineClasses(column.class, column.className);
  return combined === "" ? undefined : combined;
};

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
            const className = cellClassName(columns[i] ?? { header: "" });
            return className === undefined ? (
              <td>{cell}</td>
            ) : (
              <td class={className}>{cell}</td>
            );
          })}
        </tr>
      ))
    ) : (
      rows
    );
  return TableShell({
    body,
    bodyAttrs,
    foot,
    headerRow: (
      <tr>
        {columns.map((c) =>
          renderHeaderCell(c.header, cellClassName(c) ?? ""),
        )}
      </tr>
    ),
    scrollClass,
    tableClass,
  });
};
