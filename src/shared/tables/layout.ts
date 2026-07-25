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
export type TableLayout<TKey extends string> = {
  readonly columnKeys: readonly TKey[];
  readonly filters: ReadonlyMap<TKey, string>;
};

/** One configurable table's complete pure layout contract. */
export type TableLayoutDefinition<TKey extends string> = {
  readonly defaultColumnKeys: readonly TKey[];
  readonly defaultLayout: TableLayout<TKey>;
  readonly defaultTemplate: string;
  readonly keys: readonly TKey[];
  parse: (template: string) => TableLayout<TKey>;
  validate: (template: string) => string | null;
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

interface LayoutParts<TKey extends string> {
  columns: TKey[];
  filters: Map<TKey, string>;
  seen: Set<string>;
}

type CollectedLayout<TKey extends string> = Result<LayoutParts<TKey>>;
type ParsedLayout<TKey extends string> = Result<
  Pick<LayoutParts<TKey>, "columns" | "filters">
>;

/** Reduce step for parseColumnTemplate: collect each {{tag}} into columns
 *  and filters, rejecting unknown keys loudly. */
const collectColumnTag =
  <TKey extends string>(validKeys: readonly TKey[]) =>
  (
    result: CollectedLayout<TKey>,
    match: RegExpMatchArray,
  ): CollectedLayout<TKey> => {
    if (!result.ok) return result;
    const { key, filter } = parseTagBody(match[1]!);
    const validKey = validKeys.find((candidate) => candidate === key);
    if (validKey === undefined) {
      return {
        error: `Unknown column "${key}". Available columns: ${validKeys.join(", ")}`,
        ok: false,
      };
    }
    const { columns, filters, seen } = result.value;
    // Only the first occurrence controls the column's position and filter.
    if (!seen.has(key)) {
      seen.add(key);
      columns.push(validKey);
      if (filter) filters.set(validKey, filter);
    }
    return result;
  };

const parseColumnTemplate =
  <TKey extends string>(validKeys: readonly TKey[]) =>
  (template: string): ParsedLayout<TKey> => {
    const collected = reduce(collectColumnTag(validKeys), {
      ok: true,
      value: {
        columns: [] as TKey[],
        filters: new Map<TKey, string>(),
        seen: new Set(),
      },
    } satisfies CollectedLayout<TKey>)([...template.matchAll(LIQUID_TAG_RE)]);
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
export const parseLayout = <TKey extends string>(
  template: string,
  validKeys: readonly TKey[],
  defaultLayout: TableLayout<TKey>,
): TableLayout<TKey> => {
  if (!template) return defaultLayout;
  const result = parseColumnTemplate(validKeys)(template);
  if (!result.ok) throw new Error(result.error);
  return {
    columnKeys: result.value.columns,
    filters: result.value.filters,
  };
};

/** Validate a Liquid column template. Returns the error string when invalid,
 *  `null` when valid (or empty — empty is the "use the default" sentinel). */
export const validateLayout = <TKey extends string>(
  template: string,
  validKeys: readonly TKey[],
): string | null => {
  if (!template) return null;
  const result = parseColumnTemplate(validKeys)(template);
  return result.ok ? null : result.error;
};

type ColumnKeyOptions<TKey extends string> = {
  readonly options: readonly TKey[];
};

/** Bind a schema's complete key set to one default order and parser. */
export const defineTableLayout = <TKey extends string>(
  keySchema: ColumnKeyOptions<TKey>,
  defaultColumnKeys: readonly TKey[],
): TableLayoutDefinition<TKey> => {
  const keys = keySchema.options;
  const uniqueKeys = new Set(keys);
  if (uniqueKeys.size !== keys.length) {
    throw new Error("defineTableLayout: column keys must be unique");
  }
  for (const key of defaultColumnKeys) {
    if (!uniqueKeys.has(key)) {
      throw new Error(
        `defineTableLayout: default key "${key}" is not configurable`,
      );
    }
  }
  const defaultLayout: TableLayout<TKey> = {
    columnKeys: defaultColumnKeys,
    filters: new Map(),
  };
  return {
    defaultColumnKeys,
    defaultLayout,
    defaultTemplate: buildDefaultTemplate(defaultColumnKeys),
    keys,
    parse: (template: string): TableLayout<TKey> =>
      parseLayout(template, keys, defaultLayout),
    validate: (template: string): string | null =>
      validateLayout(template, keys),
  };
};
