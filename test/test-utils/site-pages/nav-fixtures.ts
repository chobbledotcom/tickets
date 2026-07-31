/**
 * Plain fixtures for the public site-page navigation. The nav model is built
 * by the real core from these rows, so a test can feed a shaped tree in and
 * assert what gets rendered. Not itself a test file.
 */

import { sitePageItemTargets } from "#shared/site-pages/target.ts";
import type { TargetKey } from "#shared/site-pages/types.ts";
import type {
  SitePageItem,
  SitePageItemType,
  SitePageNavRow,
} from "#shared/types.ts";

/** The key the nav model knows one thing by. */
export const navKey = (type: SitePageItemType, id: number): TargetKey =>
  sitePageItemTargets.key(sitePageItemTargets.of(type)(id));

/** One page in the nav, named and slugged after its id. */
export const navPage = (id: number, sortOrder = 0): SitePageNavRow => ({
  id,
  name: `Page ${id}`,
  slug: `page-${id}`,
  sort_order: sortOrder,
});

/** One "this page contains that thing" link. */
export const navEdge = (
  pageId: number,
  type: SitePageItem["item_type"],
  itemId: number,
  sortOrder = 0,
): SitePageItem => ({
  item_id: itemId,
  item_type: type,
  page_id: pageId,
  sort_order: sortOrder,
});
