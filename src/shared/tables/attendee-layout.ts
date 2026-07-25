/**
 * Pure layout metadata for the attendee-table column-order setting — the
 * column keys, default order, default template, layout parser, and validator,
 * with no UI imports. The cell renderers live in `attendee-table.tsx` and
 * attach on top of this layout via `defineTable`.
 *
 * The split exists so `src/shared/db/settings.ts` and other startup paths can
 * parse a saved column-order template without transitively importing the
 * cell renderers (and the form/capacity helpers those renderers pull in).
 * Keep this module pure: no JSX, no UI imports.
 */

import type { TableLayout } from "#shared/tables/layout.ts";
import {
  buildDefaultTemplate,
  parseLayout,
  validateLayout,
} from "#shared/tables/layout.ts";

/** Every attendee-table column key — the universe the layout parser
 *  accepts. There are no extras: every key here appears in the default order
 *  too, so a saved template can only reorder, not introduce new ones.
 *  (The attendee table's default column set IS this full list — when a
 *  table has no configurable extras, `defineTable` defaults its
 *  `defaultColumnKeys` to `configKeys`, so callers reaching for one name
 *  get the same list as the other.) */
export const ATTENDEE_COLUMN_KEYS = [
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
] as const;

const ATTENDEE_DEFAULT_LAYOUT: TableLayout = {
  columnKeys: ATTENDEE_COLUMN_KEYS,
  filters: new Map(),
};

export const ATTENDEE_TABLE_LAYOUT = {
  keys: ATTENDEE_COLUMN_KEYS,
  defaultColumnKeys: ATTENDEE_COLUMN_KEYS,
  defaultTemplate: buildDefaultTemplate(ATTENDEE_COLUMN_KEYS),
  defaultLayout: ATTENDEE_DEFAULT_LAYOUT,
  parse: (template: string): TableLayout =>
    parseLayout(template, ATTENDEE_COLUMN_KEYS, ATTENDEE_DEFAULT_LAYOUT),
  validate: (template: string): string | null =>
    validateLayout(template, ATTENDEE_COLUMN_KEYS),
};
