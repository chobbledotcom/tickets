/** Parse and validate configurable table column layouts without loading the
 * Liquid rendering engine used later to format cell values. */

import * as v from "valibot";
import { reduce } from "#fp";
import type { Result } from "#shared/result.ts";

export type ColumnLayout<TColumn extends string> = {
  readonly columnKeys: readonly TColumn[];
  readonly filters: ReadonlyMap<TColumn, string>;
};

const LIQUID_TAG_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

const parseTagBody = (
  body: string,
): { key: string; filter: string | undefined } => {
  const pipeIdx = body.indexOf("|");
  if (pipeIdx === -1) return { filter: undefined, key: body.trim() };
  return { filter: body.trim(), key: body.slice(0, pipeIdx).trim() };
};

interface LayoutParts<T extends string> {
  columns: T[];
  filters: Map<T, string>;
  seen: Set<T>;
}

type CollectedLayout<T extends string> = Result<LayoutParts<T>>;

type ParsedLayout<T extends string> = Result<
  Pick<LayoutParts<T>, "columns" | "filters">
>;

type ColumnSchema = v.GenericSchema<string> & {
  readonly options: readonly string[];
};

const collectColumnTag =
  <TSchema extends ColumnSchema>(schema: TSchema) =>
  (
    result: CollectedLayout<v.InferOutput<TSchema>>,
    match: RegExpMatchArray,
  ): CollectedLayout<v.InferOutput<TSchema>> => {
    if (!result.ok) return result;
    const { key, filter } = parseTagBody(match[1]!);
    const parsed = v.safeParse(schema, key);
    if (!parsed.success) {
      return {
        error: `Unknown column "${key}". Available columns: ${schema.options.join(", ")}`,
        ok: false,
      };
    }
    const option = parsed.output;
    const { columns, filters, seen } = result.value;
    if (!seen.has(option)) {
      seen.add(option);
      columns.push(option);
      if (filter) filters.set(option, filter);
    }
    return result;
  };

const parseColumnTemplate = <TSchema extends ColumnSchema>(
  template: string,
  schema: TSchema,
): ParsedLayout<v.InferOutput<TSchema>> => {
  const collected = reduce(collectColumnTag(schema), {
    ok: true,
    value: {
      columns: [],
      filters: new Map(),
      seen: new Set(),
    },
  } satisfies CollectedLayout<v.InferOutput<TSchema>>)([
    ...template.matchAll(LIQUID_TAG_RE),
  ]);
  if (!collected.ok) return collected;
  const { columns, filters } = collected.value;

  if (columns.length === 0) {
    return { error: "Template must include at least one column", ok: false };
  }

  return { ok: true, value: { columns, filters } };
};

export const buildDefaultTemplate = (keys: readonly string[]): string =>
  keys.map((key) => `{{${key}}}`).join(", ");

const defineColumnLayout = <
  const TDefault extends readonly [string, ...string[]],
  const TExtra extends readonly string[],
>(
  defaultOrder: TDefault,
  extra: TExtra,
) => {
  const [first, ...rest] = defaultOrder;
  const schema = v.picklist([first, ...rest, ...extra]);
  const defaultLayout: ColumnLayout<TDefault[number] | TExtra[number]> = {
    columnKeys: defaultOrder,
    filters: new Map(),
  };
  return {
    defaultLayout,
    defaultOrder,
    defaultTemplate: buildDefaultTemplate(defaultOrder),
    options: schema.options as readonly (TDefault[number] | TExtra[number])[],
    parse(template: string): ColumnLayout<TDefault[number] | TExtra[number]> {
      if (!template) return defaultLayout;
      const result = parseColumnTemplate(template, schema);
      if (!result.ok) throw new Error(result.error);
      return {
        columnKeys: result.value.columns,
        filters: result.value.filters,
      };
    },
    schema,
    validate(template: string): string | null {
      if (!template) return null;
      const result = parseColumnTemplate(template, schema);
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
