/**
 * Configurable column ordering for admin tables.
 *
 * Users write a Liquid-style template like "{{name}}, {{description}}, {{actions}}"
 * to define which columns appear and in what order. The template is validated
 * against a known set of column keys using a strict-variables Liquid engine.
 *
 * Each table type (events, attendees) has a COLUMN_GENERATORS record mapping
 * column keys to their rendering logic. These serve as the single source of
 * truth for available columns, default headers, and guide documentation.
 */

import { Liquid } from "liquidjs";

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
// Liquid engine for column template validation (strict variables)
// ---------------------------------------------------------------------------

/** Strict-variables engine — rejects unknown tags like {{naem}} */
const engine = new Liquid({ strictVariables: true, strictFilters: true });

// Register a passthrough `date` filter so users can write {{date | date: "%B %d"}}
// without an "unknown filter" error during validation. The filter is a no-op
// because during validation we only check that variable names are valid.
engine.registerFilter("date", (v: string) => v);

/**
 * Parse a column-order template and extract the ordered list of column keys.
 *
 * The template is rendered against a context where every valid key maps to
 * a unique marker. The output is then split on commas to recover the order.
 *
 * Returns `{ ok: true, columns: string[] }` on success, or
 * `{ ok: false, error: string }` on validation failure.
 */
export const parseColumnTemplate = (
  template: string,
  validKeys: readonly string[],
): { ok: true; columns: string[] } | { ok: false; error: string } => {
  // Build a context where each key maps to a unique marker
  const MARKER_PREFIX = "\x00COL:";
  const context: Record<string, string> = {};
  for (const key of validKeys) {
    context[key] = `${MARKER_PREFIX}${key}`;
  }

  // Parse + render synchronously (Liquid supports sync for simple templates)
  let rendered: string;
  try {
    rendered = engine.parseAndRenderSync(template, context);
  } catch (err) {
    const msg = (err as Error).message;
    // Make the error user-friendly: extract the undefined variable name
    const match = msg.match(/undefined variable: (\w+)/);
    if (match) {
      return {
        ok: false,
        error: `Unknown column "${match[1]}". Available columns: ${validKeys.join(", ")}`,
      };
    }
    return { ok: false, error: `Invalid template: ${msg}` };
  }

  // Extract column keys from the rendered output
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const part of rendered.split(",")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(MARKER_PREFIX)) {
      const key = trimmed.slice(MARKER_PREFIX.length);
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }

  if (columns.length === 0) {
    return {
      ok: false,
      error: "Template must include at least one column",
    };
  }

  return { ok: true, columns };
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
 * Get ordered column definitions from a template string.
 * Falls back to the default column order if the template is empty or invalid.
 */
export const getOrderedColumns = <TRow, TOpts>(
  template: string,
  generators: ColumnGenerators<TRow, TOpts>,
  defaultOrder: readonly string[],
): ColumnDef<TRow, TOpts>[] => {
  const keys = template
    ? (() => {
        const result = parseColumnTemplate(template, Object.keys(generators));
        return result.ok ? result.columns : [...defaultOrder];
      })()
    : [...defaultOrder];

  return keys.reduce<ColumnDef<TRow, TOpts>[]>((acc, key) => {
    const col = generators[key];
    if (col) acc.push(col);
    return acc;
  }, []);
};
