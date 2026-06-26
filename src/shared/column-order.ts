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

import { createBaseLiquidEngine } from "#shared/currency.ts";

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
const engine = createBaseLiquidEngine();

// ---------------------------------------------------------------------------
// Template parsing — regex-based extraction + validation
// ---------------------------------------------------------------------------

/** Regex to extract Liquid output tags: {{ expression }} */
const LIQUID_TAG_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

/**
 * Extract the column key and optional filter expression from a Liquid tag body.
 * "name"                 → { key: "name", filter: undefined }
 * "date | date: \"%B\""  → { key: "date", filter: "date | date: \"%B\"" }
 */
const parseTagBody = (
  body: string,
): { key: string; filter: string | undefined } => {
  const pipeIdx = body.indexOf("|");
  if (pipeIdx === -1) return { filter: undefined, key: body.trim() };
  return { filter: body.trim(), key: body.slice(0, pipeIdx).trim() };
};

/**
 * Parse a column-order template and extract the ordered list of column keys
 * plus any per-column Liquid filter expressions.
 *
 * Validation is done by checking extracted keys against the valid set.
 * No Liquid engine is needed for validation — just regex + Set.has().
 */
const parseColumnTemplate = (
  template: string,
  validKeys: readonly string[],
):
  | { ok: true; columns: string[]; filters: Map<string, string> }
  | {
      ok: false;
      error: string;
    } => {
  const validKeySet = new Set(validKeys);
  const columns: string[] = [];
  const filters = new Map<string, string>();
  const seen = new Set<string>();

  for (const match of template.matchAll(LIQUID_TAG_RE)) {
    const { key, filter } = parseTagBody(match[1]!);
    if (!validKeySet.has(key)) {
      return {
        error: `Unknown column "${key}". Available columns: ${validKeys.join(
          ", ",
        )}`,
        ok: false,
      };
    }
    if (!seen.has(key)) {
      seen.add(key);
      columns.push(key);
      if (filter) filters.set(key, filter);
    }
  }

  if (columns.length === 0) {
    return { error: "Template must include at least one column", ok: false };
  }

  return { columns, filters, ok: true };
};

/**
 * Validate a column-order template without extracting columns.
 * Returns null if valid, or an error message string if invalid.
 */
export const validateColumnTemplate = (
  template: string,
  validKeys: readonly string[],
): string | null => {
  const result = parseColumnTemplate(template, validKeys);
  return result.ok ? null : result.error;
};

/**
 * Build a default template from an ordered list of column keys.
 * Produces e.g. "{{name}}, {{description}}, {{actions}}"
 */
export const buildDefaultTemplate = (keys: readonly string[]): string =>
  keys.map((k) => `{{${k}}}`).join(", ");

/**
 * Parse a template and return column keys + filters, with fallback to defaults.
 * Shared by all listing/attendee table renderers.
 */
export const resolveColumnLayout = (
  template: string,
  validKeys: readonly string[],
  defaultOrder: readonly string[],
): { columnKeys: string[]; filters: Map<string, string> } => {
  if (!template) {
    return { columnKeys: [...defaultOrder], filters: new Map() };
  }
  const result = parseColumnTemplate(template, validKeys);
  return result.ok
    ? { columnKeys: result.columns, filters: result.filters }
    : { columnKeys: [...defaultOrder], filters: new Map() };
};

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
  // built-in strftime works correctly.
  let contextValue = rawValue;
  if (typeof rawValue === "string" && expression.includes("| date")) {
    const d = new Date(rawValue);
    if (!Number.isNaN(d.getTime())) contextValue = d;
  }
  const result = engine.parseAndRenderSync(`{{ ${expression} }}`, {
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
  columnKeys: string[],
  generators: ColumnGenerators<TRow, TOpts>,
  opts: TOpts,
  filters: Map<string, string>,
  escapeHtml: (s: string) => string,
): string => {
  const cells: string[] = [];
  for (const key of columnKeys) {
    const col = generators[key]!;
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
