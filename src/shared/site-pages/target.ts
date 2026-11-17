/**
 * What a site page points at: a listing, a group, or another page.
 *
 * The naming, the stable key, and the SQL all come from the shared
 * record-target vocabulary; this module only says which kinds a page item may
 * be and which columns hold them. It is pure data-in/data-out — the edge
 * reads and writes live in `#shared/db/site-page-items.ts`.
 */

import {
  defineRecordTarget,
  ITEM_TARGET_COLUMNS,
  type RecordTarget,
  type RecordTargets,
} from "#db/record-target.ts";
import { type SitePageItemType, SitePageItemTypeSchema } from "#types";

/** One thing a page points at: its kind, and which one of that kind. */
export type SitePageItemTarget = RecordTarget<SitePageItemType>;

/** The thing one stored page item points at. */
export const targetOfPageItem = (item: {
  itemType: SitePageItemType;
  itemId: number;
}): SitePageItemTarget => ({ id: item.itemId, kind: item.itemType });

/** How to name and ask for the things a page points at. */
export const sitePageItemTargets: RecordTargets<SitePageItemType> =
  defineRecordTarget({
    columns: ITEM_TARGET_COLUMNS,
    kinds: SitePageItemTypeSchema.options,
  });
