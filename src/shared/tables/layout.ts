/** Parse and validate a configurable table's Liquid column template without
 *  loading the rendering engine used later to format cell values.
 *
 *  A template like `{{name}}, {{created | date: "%B"}}` becomes the column
 *  keys `["name", "created"]` and the per-key filter expressions
 *  `{"created": "created | date: \"%B\""}`. The cell renderer for each
 *  column then chooses whether to run the filter against `rawValue` or use
 *  its own `cell()` output.
 *
 *  Pure: no table metadata — callers pass the valid keys in. */

import { reduce } from "#fp";
import type { Result } from "#shared/result.ts";

/** A configurable column layout: the keys to render (in order) and the
 *  Liquid filter expressions keyed by column key. */
export type TableLayout = {
  readonly columnKeys: readonly string[];
  readonly filters: ReadonlyMap<string, string>;
};

const LIQUID_TAG_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

/** Split `{{body}}` into the column key and any filter expression.
 *  `created` → `{ key: "created", filter: undefined }`;
 *  `created | date: "%B"` → `{ key: "created", filter: "created | date: \"%B\"" }`. */
const parseTagBody = (
  body: string,
): { key: string; filter: string | undefined } => {
  const pipeIdx = body.indexOf("|");
  if (pipeIdx === -1) return { filter: undefined, key: body.trim() };
  return { filter: body.trim(), key: body.slice(0, pipeIdx).trim() };
};

interface LayoutParts {
  columns: string[];
  filters: Map<string, string>;
  seen: Set<string>;
}

type CollectedLayout = Result<LayoutParts>;
type ParsedLayout = Result<Pick<LayoutParts, "columns" | "filters">>;

/** Reduce step for parseColumnTemplate: collect each {{tag}} into columns
 *  and filters, rejecting unknown keys loudly. */
const collectColumnTag =
  (validKeys: ReadonlySet<string>) =>
  (result: CollectedLayout, match: RegExpMatchArray): CollectedLayout => {
    if (!result.ok) return result;
    const { key, filter } = parseTagBody(match[1]!);
    if (!validKeys.has(key)) {
      return {
        error: `Unknown column "${key}". Available columns: ${[...validKeys].join(", ")}`,
        ok: false,
      };
    }
    const { columns, filters, seen } = result.value;
    // First occurrence wins; later duplicates are silently dropped, matching
    // the old column-layout parser's behaviour.
    if (!seen.has(key)) {
      seen.add(key);
      columns.push(key);
      if (filter) filters.set(key, filter);
    }
    return result;
  };

const parseColumnTemplate = (
  template: string,
  validKeys: readonly string[],
): ParsedLayout => {
  const keySet = new Set(validKeys);
  const collected = reduce(collectColumnTag(keySet), {
    ok: true,
    value: {
      columns: [],
      filters: new Map(),
      seen: new Set(),
    },
  } satisfies CollectedLayout)([...template.matchAll(LIQUID_TAG_RE)]);
  if (!collected.ok) return collected;
  const { columns, filters } = collected.value;

  if (columns.length === 0) {
    return { error: "Template must include at least one column", ok: false };
  }

  return { ok: true, value: { columns, filters } };
};

/** Render the default Liquid template for the given column keys: the comma-
 *  separated `{{key}}` form shown in the column-order settings form and the
 *  guide. */
export const buildDefaultTemplate = (keys: readonly string[]): string =>
  keys.map((key) => `{{${key}}}`).join(", ");

/** Parse a Liquid column template into a {@link TableLayout}. Falls back to
 *  `defaultLayout` when the template is empty; throws on an invalid
 *  template so a saved bad layout surfaces loudly rather than silently
 *  rendering a default. */
export const parseLayout = (
  template: string,
  validKeys: readonly string[],
  defaultLayout: TableLayout,
): TableLayout => {
  if (!template) return defaultLayout;
  const result = parseColumnTemplate(template, validKeys);
  if (!result.ok) throw new Error(result.error);
  return {
    columnKeys: result.value.columns,
    filters: result.value.filters,
  };
};

/** Validate a Liquid column template. Returns the error string when invalid,
 *  `null` when valid (or empty — empty is the "use the default" sentinel). */
export const validateLayout = (
  template: string,
  validKeys: readonly string[],
): string | null => {
  if (!template) return null;
  const result = parseColumnTemplate(template, validKeys);
  return result.ok ? null : result.error;
};
