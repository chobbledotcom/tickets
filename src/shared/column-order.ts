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

import * as v from "valibot";
import { createBaseLiquidEngine } from "#shared/liquid-engine.ts";
import type { Result } from "#shared/result.ts";

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

export type ColumnLayout<TColumn extends string> = {
  readonly columnKeys: readonly TColumn[];
  readonly filters: ReadonlyMap<TColumn, string>;
};

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
 * Validation is done by parsing extracted keys through the column schema.
 * No Liquid engine is needed for validation.
 */
type ParsedLayout<T extends string> = Result<{
  columns: T[];
  filters: Map<T, string>;
}>;

const parseColumnTemplate = <T extends string>(
  template: string,
  options: readonly T[],
): ParsedLayout<T> => {
  const columns: T[] = [];
  const filters = new Map<T, string>();
  const seen = new Set<string>();

  for (const match of template.matchAll(LIQUID_TAG_RE)) {
    const { key, filter } = parseTagBody(match[1]!);
    const option = options.find((value) => value === key);
    if (option === undefined) {
      return {
        error: `Unknown column "${key}". Available columns: ${options.join(", ")}`,
        ok: false,
      };
    }
    if (!seen.has(option)) {
      seen.add(option);
      columns.push(option);
      if (filter) filters.set(option, filter);
    }
  }

  if (columns.length === 0) {
    return { error: "Template must include at least one column", ok: false };
  }

  return { ok: true, value: { columns, filters } };
};

/**
 * Validate a column-order template without extracting columns.
 * Returns null if valid, or an error message string if invalid.
 */
/**
 * Build a default template from an ordered list of column keys.
 * Produces e.g. "{{name}}, {{description}}, {{actions}}"
 */
export const buildDefaultTemplate = (keys: readonly string[]): string =>
  keys.map((k) => `{{${k}}}`).join(", ");

/**
 * Parse a template and return column keys and filters.
 * Shared by all listing/attendee table renderers.
 */
const defineColumnLayout = <
  const TDefault extends readonly [string, ...string[]],
  const TExtra extends readonly string[],
>(
  defaultOrder: TDefault,
  extra: TExtra,
) => {
  const [first, ...rest] = defaultOrder;
  const schema = v.picklist([first, ...rest, ...extra]);
  const options: readonly (TDefault[number] | TExtra[number])[] = [
    ...defaultOrder,
    ...extra,
  ];
  const defaultLayout: ColumnLayout<TDefault[number] | TExtra[number]> = {
    columnKeys: defaultOrder,
    filters: new Map(),
  };
  return {
    defaultLayout,
    defaultOrder,
    defaultTemplate: buildDefaultTemplate(defaultOrder),
    options,
    parse(template: string): ColumnLayout<TDefault[number] | TExtra[number]> {
      if (!template) return defaultLayout;
      const result = parseColumnTemplate(template, options);
      if (!result.ok) throw new Error(result.error);
      return {
        columnKeys: result.value.columns,
        filters: result.value.filters,
      };
    },
    schema,
    validate(template: string): string | null {
      if (!template) return null;
      const result = parseColumnTemplate(template, options);
      return result.ok ? null : result.error;
    },
  };
};

export const COLUMN_LAYOUTS = {
  attendee: defineColumnLayout(
    [
      "status",
      "date",
      "name",
      "listings",
      "email",
      "phone",
      "address",
      "special_instructions",
      "answers",
      "qty",
      "ticket",
      "registered",
    ],
    [],
  ),
  listing: defineColumnLayout(
    [
      "name",
      "description",
      "status",
      "attendees",
      "tickets",
      "revenue",
      "cost",
      "profit",
      "created",
    ],
    ["date", "location", "price", "renewal"],
  ),
};

export type ColumnLayoutKind = keyof typeof COLUMN_LAYOUTS;
export type ListingColumn =
  (typeof COLUMN_LAYOUTS)["listing"]["options"][number];
export type AttendeeColumn =
  (typeof COLUMN_LAYOUTS)["attendee"]["options"][number];

export type ListingColumnLayout = ReturnType<
  (typeof COLUMN_LAYOUTS)["listing"]["parse"]
>;
export type AttendeeColumnLayout = ReturnType<
  (typeof COLUMN_LAYOUTS)["attendee"]["parse"]
>;

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
