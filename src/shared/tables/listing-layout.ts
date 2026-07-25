/**
 * Pure layout metadata for the configurable admin tables — the column keys,
 * default order, default template, layout parser, and validator, with no UI
 * imports. The cell renderers (which need JSX, image helpers, etc.) live in
 * `listing-table.tsx` and attach on top of this layout via `defineTable`.
 *
 * The split exists so `src/shared/db/settings.ts` and other startup paths can
 * parse a saved column-order template without transitively importing the
 * cell renderers (and the heavy `#templates/public/shared.tsx` image helper
 * those renderers pull in). Keep this module pure: no JSX, no UI imports.
 */

import type { TableLayout } from "#shared/tables/layout.ts";
import {
  buildDefaultTemplate,
  parseLayout,
  validateLayout,
} from "#shared/tables/layout.ts";

/** The complete set of listing-table column keys the user may reference in a
 *  saved template: the 9 defaults plus the 4 optional extras. The layout
 *  parser rejects any key outside this list. Ordered defaults-first so the
 *  default template reads in natural order. */
export const LISTING_COLUMN_KEYS = [
  "name",
  "description",
  "status",
  "attendees",
  "tickets",
  "revenue",
  "cost",
  "profit",
  "created",
  "date",
  "location",
  "price",
  "renewal",
] as const;

/** The 9 listing columns shown when no user template is saved. */
export const LISTING_DEFAULT_COLUMN_KEYS = LISTING_COLUMN_KEYS.slice(0, 9);

const LISTING_DEFAULT_LAYOUT: TableLayout = {
  columnKeys: LISTING_DEFAULT_COLUMN_KEYS,
  filters: new Map(),
};

/** The listing-table layout: pure metadata + parse/validate for the saved
 *  template setting. Cell renderers live in `listing-table.tsx`. */
export const LISTING_TABLE_LAYOUT = {
  keys: LISTING_COLUMN_KEYS,
  defaultColumnKeys: LISTING_DEFAULT_COLUMN_KEYS,
  defaultTemplate: buildDefaultTemplate(LISTING_DEFAULT_COLUMN_KEYS),
  defaultLayout: LISTING_DEFAULT_LAYOUT,
  parse: (template: string): TableLayout =>
    parseLayout(template, LISTING_COLUMN_KEYS, LISTING_DEFAULT_LAYOUT),
  validate: (template: string): string | null =>
    validateLayout(template, LISTING_COLUMN_KEYS),
};
