/**
 * The site-pages "acquire ring": the one DB read that both the admin data
 * builders and the public nav share. Loads the nav-row projection and the item
 * edges together and folds them into the forest, keeping the DB access out of
 * the pure {@link buildForest} core.
 */

import { getAllPageItems } from "#shared/db/site-page-items.ts";
import { sitePages } from "#shared/db/site-pages.ts";
import { buildForest } from "#shared/site-pages/core.ts";
import type { Forest } from "#shared/site-pages/types.ts";
import type { SitePageItem, SitePageNavRow } from "#shared/types.ts";

/** Load the nav rows + item edges once and fold them into the page forest,
 * returning the forest plus the raw rows/items its callers still consume. */
export const loadPageForest = async (): Promise<{
  forest: Forest;
  navRows: SitePageNavRow[];
  items: SitePageItem[];
}> => {
  const [navRows, items] = await Promise.all([
    sitePages.getAll(),
    getAllPageItems(),
  ]);
  return { forest: buildForest(navRows, items), items, navRows };
};
