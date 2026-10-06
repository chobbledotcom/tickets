/**
 * Read-model builders for Site → Pages: the page forest loader, the list-page
 * model, and the edit/items model (a page's resolved contents plus the
 * add-item picker options). Shared by the route handlers (site-pages.ts) and
 * the tabbed entity page (site-pages-page.ts), so both build the same data.
 */

import { getAllGroupNames } from "#db/groups.ts";
import { getNonStandaloneChildIds } from "#db/listing-parents.ts";
import {
  getListingPickerNames,
  type ListingOfferFlags,
} from "#db/listings/catalog.ts";
import { getAllPageItems } from "#db/site-page-items.ts";
import { sitePages } from "#db/site-pages.ts";
import { fieldById } from "#fp";
import { t } from "#i18n";
// jscpd:ignore-start
import { isQualifyingTierListing } from "#shared/renewal-tier.ts";
import { buildForest, eligibleChildPages } from "#shared/site-pages/core.ts";
import { loadPageForest } from "#shared/site-pages/load.ts";
import {
  sitePageItemTargets,
  targetOfPageItem,
} from "#shared/site-pages/target.ts";
import type {
  EditModel,
  ListModel,
  PickerOption,
  ResolvedItem,
} from "#templates/admin/site-pages.tsx";
// jscpd:ignore-end
import type { SitePage, SitePageItemType } from "#types";

/** Can this listing be placed on a page? Active (its public page must not
 * 404), not a renewal tier, and not a child listing. A renewal tier needs a
 * site token the normal ticket flow never supplies
 * ({@link isQualifyingTierListing}). A booking can never start from a child
 * (`childIds`), so its `/ticket` page 404s too. */
export const offerableListing = (
  id: number,
  row: ListingOfferFlags,
  childIds: ReadonlySet<number>,
): boolean => row.active && !isQualifyingTierListing(row) && !childIds.has(id);

/** Build the list-page model: root pages (reorderable) and nested pages (shown
 * with their parent, edited through the item manager). */
export const buildListModel = async (): Promise<ListModel> => {
  const { forest, navRows } = await loadPageForest();
  const roots = forest.rootIds.map((id) => forest.byId.get(id)!);
  const nested = navRows
    .filter((p) => forest.parentByChild.has(p.id))
    .map((p) => ({
      page: p,
      // parentByChild only maps children whose parent is a real page in byId.
      parentName: forest.byId.get(forest.parentByChild.get(p.id)!)!.name,
    }));
  return { nested, roots };
};

/** Resolve a page's items to display rows + the add-item picker options. */
export const buildEditModel = async (page: SitePage): Promise<EditModel> => {
  // Pickers/labels need only id + name, so use the narrow name projections
  // rather than the full listings/groups caches (no decrypting every column).
  const [navRows, allItems, listingNames, groupNames] = await Promise.all([
    sitePages.getAll(),
    getAllPageItems(),
    getListingPickerNames(),
    getAllGroupNames(),
  ]);
  // The page's own items are a filter over the already-loaded edge set (same
  // (sort_order, item_id) ordering as the per-page query) — not a fifth read.
  const pageItems = allItems.filter((i) => i.page_id === page.id);
  const forest = buildForest(navRows, allItems);
  const pageById = fieldById("name")(navRows);
  const label = (type: SitePageItemType, id: number): string => {
    const lookup: Record<SitePageItemType, string | undefined> = {
      group: groupNames.get(id),
      listing: listingNames.get(id)?.name,
      page: pageById.get(id),
    };
    return lookup[type] ?? t("site.pages.item_missing");
  };
  const items: ResolvedItem[] = pageItems.map((i) => ({
    id: i.item_id,
    label: label(i.item_type, i.item_id),
    type: i.item_type,
  }));
  const opt = (id: number, name: string): PickerOption => ({
    label: name,
    value: String(id),
  });
  // A leaf can sit on a page only once (unique (page_id, item_type, item_id)),
  // so the pickers drop targets already present.
  const present = new Set(
    pageItems.map((i) => sitePageItemTargets.key(targetOfPageItem(i))),
  );
  const options = (
    names: Map<number, string>,
    type: SitePageItemType,
  ): PickerOption[] =>
    [...names]
      .filter(
        ([id]) =>
          !present.has(
            sitePageItemTargets.key(sitePageItemTargets.of(type)(id)),
          ),
      )
      .map(([id, name]) => opt(id, name));
  // The listing picker offers only OFFERABLE listings. Active, because an
  // inactive listing's public page 404s. Not a renewal tier: a tier bought
  // through a normal public link takes payment without extending the site.
  // Not a non-standalone child: its public page 404s by construction. A
  // `bookable_alone` child keeps its page, so it stays offerable. Labels
  // above still read the full map.
  const childIds = await getNonStandaloneChildIds([...listingNames.keys()]);
  const activeListingNames = new Map(
    [...listingNames]
      .filter(([id, l]) => offerableListing(id, l, childIds))
      .map(([id, l]) => [id, l.name]),
  );
  return {
    groupOptions: options(groupNames, "group"),
    items,
    listingOptions: options(activeListingNames, "listing"),
    page,
    pageOptions: eligibleChildPages(forest, page.id).map((p) =>
      opt(p.id, p.name),
    ),
  };
};
