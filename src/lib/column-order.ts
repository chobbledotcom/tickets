/**
 * Configurable column ordering for admin tables.
 *
 * Users write a Liquid-style template like "{{name}}, {{description}}, {{actions}}"
 * to define which columns appear and in what order. The template is validated
 * against a known set of column keys using a strict-variables Liquid engine.
 *
 * Columns can also use Liquid filters for custom formatting:
 *   {{created | date: "%B %d, %Y"}}  →  "April 10, 2026"
 *   {{price | currency}}              →  "£25.00"
 *
 * Each table type (events, attendees) has a COLUMN_GENERATORS record mapping
 * column keys to their rendering logic. These serve as the single source of
 * truth for available columns, default headers, and guide documentation.
 */

import { Liquid } from "liquidjs";
import { formatCurrency } from "#lib/currency.ts";
import { DAY_NAMES, MONTH_NAMES } from "#lib/dates.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Definition for a single table column */
export type ColumnDef<TRow, TOpts = unknown> = {
  /** Human-readable label shown in the guide and as default <th> text */
  label: string;
  /** Short description for the guide */
  description: string;
  /** Render the <th> inner content */
  header: () => string;
  /** Render the <td> inner content for a row */
  cell: (row: TRow, opts: TOpts) => string;
  /**
   * Return the raw Liquid-friendly value for this column (e.g. ISO date string).
   * When present and the user applies a Liquid filter (e.g. `| date: "%B"`),
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

/**
 * Parsed column template result.
 * `columns` is the ordered list of column keys.
 * `filters` maps column keys to their full Liquid expression when a filter
 * is used (e.g. `"created"` → `"created | date: \"%B %d\""`)
 */
export type ParsedTemplate = {
  columns: string[];
  filters: Map<string, string>;
};

// ---------------------------------------------------------------------------
// Liquid engines
// ---------------------------------------------------------------------------

/** Strict-variables engine for validation — rejects unknown tags like {{naem}} */
const validationEngine = new Liquid({
  strictVariables: true,
  strictFilters: true,
});

// Register passthrough filters so validation doesn't reject them.
// The actual rendering uses a separate engine with real implementations.
validationEngine.registerFilter("date", (v: string) => v);
validationEngine.registerFilter("currency", (v: string) => v);

/** Rendering engine — applies real Liquid filters to raw column values */
const renderEngine = new Liquid({
  strictVariables: false,
  strictFilters: true,
});

renderEngine.registerFilter("currency", (v: string | number) =>
  formatCurrency(v),
);
// LiquidJS has a built-in `date` filter using strftime, but it needs
// a Date object or a parseable date string. We register a wrapper that
// ensures the input is parsed correctly.
renderEngine.registerFilter("date", (v: string | number, format?: string) => {
  if (!v) return "";
  const d = new Date(String(v));
  if (isNaN(d.getTime())) return String(v);
  if (!format) return d.toLocaleDateString();
  return formatStrftime(d, format);
});

/** Minimal strftime implementation for Liquid date filter */
const formatStrftime = (d: Date, fmt: string): string => {
  const pad = (n: number) => String(n).padStart(2, "0");
  const shortMonths = MONTH_NAMES.map((m) => m.slice(0, 3));
  const shortDays = DAY_NAMES.map((d) => d.slice(0, 3));
  return fmt.replace(/%([a-zA-Z%])/g, (_, code: string) => {
    switch (code) {
      case "Y":
        return String(d.getFullYear());
      case "y":
        return String(d.getFullYear()).slice(-2);
      case "m":
        return pad(d.getMonth() + 1);
      case "d":
        return pad(d.getDate());
      case "e":
        return String(d.getDate());
      case "H":
        return pad(d.getHours());
      case "M":
        return pad(d.getMinutes());
      case "S":
        return pad(d.getSeconds());
      case "B":
        return MONTH_NAMES[d.getMonth()]!;
      case "b":
        return shortMonths[d.getMonth()]!;
      case "A":
        return DAY_NAMES[d.getDay()]!;
      case "a":
        return shortDays[d.getDay()]!;
      case "p":
        return d.getHours() >= 12 ? "PM" : "AM";
      case "I": {
        const h = d.getHours() % 12;
        return pad(h === 0 ? 12 : h);
      }
      case "%":
        return "%";
      default:
        return `%${code}`;
    }
  });
};

// ---------------------------------------------------------------------------
// Template parsing
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
  if (pipeIdx === -1) {
    return { key: body.trim(), filter: undefined };
  }
  return {
    key: body.slice(0, pipeIdx).trim(),
    filter: body.trim(),
  };
};

/**
 * Parse a column-order template and extract the ordered list of column keys
 * plus any per-column Liquid filter expressions.
 *
 * The template is validated by rendering it through the strict-variables engine.
 * Filter expressions are extracted via regex so they can be applied at render time.
 *
 * Returns `{ ok: true, ...ParsedTemplate }` on success, or
 * `{ ok: false, error: string }` on validation failure.
 */
export const parseColumnTemplate = (
  template: string,
  validKeys: readonly string[],
): ({ ok: true } & ParsedTemplate) | { ok: false; error: string } => {
  // Build a context where each key maps to a unique marker
  const MARKER_PREFIX = "\x00COL:";
  const context: Record<string, string> = {};
  for (const key of validKeys) {
    context[key] = `${MARKER_PREFIX}${key}`;
  }

  // Validate by rendering through the strict engine
  try {
    validationEngine.parseAndRenderSync(template, context);
  } catch (err) {
    const msg = (err as Error).message;
    const match = msg.match(/undefined variable: (\w+)/);
    if (match) {
      return {
        ok: false,
        error: `Unknown column "${match[1]}". Available columns: ${validKeys.join(", ")}`,
      };
    }
    return { ok: false, error: `Invalid template: ${msg}` };
  }

  // Extract column keys and filter expressions from the raw template
  const columns: string[] = [];
  const filters = new Map<string, string>();
  const seen = new Set<string>();
  const validKeySet = new Set(validKeys);

  for (const match of template.matchAll(LIQUID_TAG_RE)) {
    const { key, filter } = parseTagBody(match[1]!);
    if (validKeySet.has(key) && !seen.has(key)) {
      seen.add(key);
      columns.push(key);
      if (filter) {
        filters.set(key, filter);
      }
    }
  }

  if (columns.length === 0) {
    return {
      ok: false,
      error: "Template must include at least one column",
    };
  }

  return { ok: true, columns, filters };
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
 * Shared by all event/attendee table renderers.
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
  if (!result.ok) {
    return { columnKeys: [...defaultOrder], filters: new Map() };
  }
  return { columnKeys: result.columns, filters: result.filters };
};

/**
 * Render a single column value through a Liquid filter expression.
 * Used when a column has a rawValue and the user applied a filter.
 *
 * @param expression - The Liquid expression body, e.g. `"created | date: \"%B %d\""`
 * @param rawValue - The raw value from the column's rawValue() function
 * @param key - The column key (used as the variable name in the context)
 */
export const renderFilteredValue = (
  expression: string,
  rawValue: unknown,
  key: string,
): string => {
  const template = `{{ ${expression} }}`;
  const result = renderEngine.parseAndRenderSync(template, { [key]: rawValue });
  return result.trim();
};
