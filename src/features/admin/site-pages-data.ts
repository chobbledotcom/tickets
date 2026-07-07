/**
 * Read-model builders for Site → Pages: the page forest loader, the list-page
 * model, and the edit/items model (a page's resolved contents plus the
 * add-item picker options). Shared by the route handlers (site-pages.ts) and
 * the tabbed entity page (site-pages-page.ts), so both build the same data.
 */

// jscpd:ignore-start
import { t } from "#i18n";
import { getAllGroupNames } from "#shared/db/groups.ts";
import { getNonStandaloneChildIds } from "#shared/db/listing-parents.ts";
import {
  getListingPickerNames,
  type ListingOfferFlags,
} from "#shared/db/listings.ts";
import { getAllPageItems } from "#shared/db/site-page-items.ts";
import { getSitePageNavRows } from "#shared/db/site-pages.ts";
import { isQualifyingTierListing } from "#shared/site-assignment.ts";
import {
  buildForest,
  eligibleChildPages,
  targetKey,
} from "#shared/site-pages/core.ts";
// jscpd:ignore-end
import type { Forest } from "#shared/site-pages/types.ts";
import type {
  SitePage,
  SitePageItemType,
  SitePageNavRow,
} from "#shared/types.ts";
import type {
  EditModel,
  ListModel,
  PickerOption,
  ResolvedItem,
} from "#templates/admin/site-pages.tsx";

/** May this listing be placed on a page? Active (its public page must not
 * 404), not a renewal tier ({@link isQualifyingTierListing} — the renewal
 * flow requires a site token the normal ticket flow never supplies), and not
 * a child listing (`childIds` — a booking can never start from a child,
 * so its `/ticket` page 404s too). */
export const offerableListing = (
  id: number,
  row: ListingOfferFlags,
  childIds: ReadonlySet<number>,
): boolean => row.active && !isQualifyingTierListing(row) && !childIds.has(id);

/** Load the nav rows + item edges once and fold them into the page forest. */
export const loadForest = async (): Promise<{
  forest: Forest;
  navRows: SitePageNavRow[];
}> => {
  const [navRows, items] = await Promise.all([
    getSitePageNavRows(),
    getAllPageItems(),
  ]);
  return { forest: buildForest(navRows, items), navRows };
};

/** Build the list-page model: root pages (reorderable) and nested pages (shown
 * with their parent, edited through the item manager). */
export const buildListModel = async (): Promise<ListModel> => {
  const { forest, navRows } = await loadForest();
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
    getSitePageNavRows(),
    getAllPageItems(),
    getListingPickerNames(),
    getAllGroupNames(),
  ]);
  // The page's own items are a filter over the already-loaded edge set (same
  // (sort_order, item_id) ordering as the per-page query) — not a fifth read.
  const pageItems = allItems.filter((i) => i.page_id === page.id);
  const forest = buildForest(navRows, allItems);
  const pageById = new Map(navRows.map((r) => [r.id, r.name]));
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
  // A leaf may sit on a page only once (unique (page_id, item_type, item_id)),
  // so drop targets already present from the pickers.
  const present = new Set(
    pageItems.map((i) => targetKey(i.item_type, i.item_id)),
  );
  const options = (
    names: Map<number, string>,
    type: SitePageItemType,
  ): PickerOption[] =>
    [...names]
      .filter(([id]) => !present.has(targetKey(type, id)))
      .map(([id, name]) => opt(id, name));
  // The listing picker offers only OFFERABLE listings — active (an inactive
  // listing's public page 404s), not a renewal tier (a tier bought through a
  // normal public link would take payment without extending the site), and
  // not a non-standalone child (its public page 404s by construction;
  // a `bookable_alone` child keeps its page, so it stays
  // offerable). Labels above still read the full map.
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
