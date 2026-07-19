/**
 * Configurable column ordering for admin tables.
 *
 * Users write a Liquid-style template like "{{name}}, {{description}}, {{actions}}"
 * to define which columns appear and in what order. The template is validated
 * against a known set of column keys using regex extraction + set membership.
 *
 * Columns can also use Liquid filters for custom formatting:
 *   {{created | date: "%B %d, %Y"}}  →  "April 10, 2026"
 *   {{price | currency}}              →  "£25.00"
 */

import { once } from "#fp";
import { createBaseLiquidEngine } from "#shared/liquid-engine.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Definition for a single table column */
export type ColumnDef<TRow, TOpts = unknown> = {
  /** Human-readable label shown in the guide and as default <th> text */
  label: string;
  /** Header text for the <th>. Defaults to `label` when omitted. */
  headerText?: string;
  /** Short description for the guide */
  description: string;
  /** Render the <td> inner content for a row */
  cell: (row: TRow, opts: TOpts) => string;
  /**
   * Return the raw Liquid-friendly value for this column (e.g. ISO date string).
   * When present and the user applies a Liquid filter (e.g. `| date: "%B"`),,
   * the filter is applied to this value instead of using `cell()`.
   */
  rawValue?: (row: TRow, opts: TOpts) => unknown;
  /** Optional CSS class for the <th> header */
  headerClassName?: string;
  /** Optional CSS class for the <td> cell */
  className?: string;
  /** Whether cell() returns pre-escaped HTML (true) or plain text (false, default) */
  isHtml?: boolean;
};

/** A record mapping column keys to their definitions */
export type ColumnGenerators<TRow, TOpts = unknown> = Record<
  string,
  ColumnDef<TRow, TOpts>
>;

// ---------------------------------------------------------------------------
// Liquid engine — single instance for rendering filtered values
// ---------------------------------------------------------------------------

// `currency` is custom; `date` is a LiquidJS built-in (strftime on Date objects).
// ISO string → Date conversion happens in renderFilteredValue before calling Liquid.
const getEngine = once(createBaseLiquidEngine);

/** Matches only when `date` is the first filter applied to the raw value */
const FIRST_FILTER_IS_DATE_RE = /^[^|]*\|\s*date\b/;

/**
 * Render a single column value through a Liquid filter expression.
 *
 * @param expression - e.g. `"created | date: \"%B %d\""`
 * @param rawValue - the raw value from the column's rawValue() function
 * @param key - the column key (used as the variable name in the context)
 */
export const renderFilteredValue = (
  expression: string,
  rawValue: unknown,
  key: string,
): string => {
  // For date filters, convert ISO strings to Date objects so LiquidJS's
  // built-in strftime works correctly. Only convert when `date` is the first
  // filter in the chain — converting for a later `| date` (e.g. a filter
  // that transforms the raw string before a date filter downstream) would
  // feed that earlier filter a Date instead of the raw string.
  let contextValue = rawValue;
  if (
    typeof rawValue === "string" &&
    FIRST_FILTER_IS_DATE_RE.test(expression)
  ) {
    const d = new Date(rawValue);
    if (!Number.isNaN(d.getTime())) contextValue = d;
  }
  const result = getEngine().parseAndRenderSync(`{{ ${expression} }}`, {
    [key]: contextValue,
  });
  return result.trim();
};

/**
 * Render a table row's cells from ordered column keys.
 * Shared by listing and attendee table renderers.
 */
export const renderCells = <TRow, TOpts>(
  row: TRow,
  columnKeys: readonly string[],
  generators: ColumnGenerators<TRow, TOpts>,
  opts: TOpts,
  filters: ReadonlyMap<string, string>,
  escapeHtml: (s: string) => string,
): string => {
  const cells: string[] = [];
  for (const key of columnKeys) {
    const col = generators[key];
    if (col === undefined) throw new Error(`Unknown column: ${key}`);
    const filterExpr = filters.get(key);
    const useFilter = filterExpr && col.rawValue;
    const content = useFilter
      ? renderFilteredValue(filterExpr, col.rawValue!(row, opts), key)
      : col.cell(row, opts);
    const cls = col.className ? ` class="${col.className}"` : "";
    // Filtered values are plain text; cell() output depends on isHtml
    const needsEscape = useFilter ? true : !col.isHtml;
    cells.push(
      needsEscape
        ? `<td${cls}>${escapeHtml(content)}</td>`
        : `<td${cls}>${content}</td>`,
    );
  }
  return cells.join("");
};

/** Get the <th> text for a column (headerText if set, otherwise label) */
export const getHeaderText = <TRow, TOpts>(
  col: ColumnDef<TRow, TOpts>,
): string => col.headerText ?? col.label;
