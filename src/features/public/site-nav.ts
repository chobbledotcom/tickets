/**
 * Acquire ring for the public site-pages nav (pages.md "Functional core"): load
 * the forest's rows plus the resolved leaf targets as plain data, then hand it
 * to the pure `buildNavModel`. Cold-start efficiency: the page/edge reads are
 * the request-cached narrow projections, and leaves resolve through
 * `linkRowsByIds` (only slug + name decrypted, only for referenced ids).
 *
 * Liveness mirrors the reachability rules the ticket routes enforce, so the
 * nav never renders a dead link (AGENTS.md): a listing is live iff it is
 * active and not a child (a booking can never start from a child, invariant
 * I3 — the ticket route rejects child slugs), and a group is live iff it has a
 * standalone-bookable member (the same gate as its QR — the group page offers
 * nothing to book otherwise). Page targets are always live.
 */

import { mapParallel } from "#fp";
import {
  getActiveListingsByGroupId,
  getGroupLinkRows,
} from "#shared/db/groups.ts";
import { getChildListingIds } from "#shared/db/listing-parents.ts";
import { getListingLinkRows } from "#shared/db/listings.ts";
import { getAllPageItems } from "#shared/db/site-page-items.ts";
import { getSitePageNavRows } from "#shared/db/site-pages.ts";
import {
  buildForest,
  buildNavModel,
  targetKey,
} from "#shared/site-pages/core.ts";
import type {
  NavModel,
  ResolvedTarget,
  TargetKey,
  TargetMap,
} from "#shared/site-pages/types.ts";
import type { SitePageItem, SitePageItemType } from "#shared/types.ts";
import { navFlags, type PublicNavProps } from "#templates/public.tsx";
import { groupHasBookableMember } from "./discovery.ts";

/** The distinct item ids of one leaf type among the loaded edges. */
const leafIds = (
  items: readonly SitePageItem[],
  type: SitePageItemType,
): number[] => [
  ...new Set(items.filter((i) => i.item_type === type).map((i) => i.item_id)),
];

/** Resolve every referenced listing/group to its presentation + liveness. */
const resolveTargets = async (
  items: readonly SitePageItem[],
): Promise<TargetMap> => {
  const listingIds = leafIds(items, "listing");
  const groupIds = leafIds(items, "group");
  const [listingRows, childIds, groupRows] = await Promise.all([
    getListingLinkRows(listingIds),
    getChildListingIds(listingIds),
    getGroupLinkRows(groupIds),
  ]);
  const targets = new Map<TargetKey, ResolvedTarget>();
  const setLeaf = (
    type: SitePageItemType,
    row: { id: number; name: string; slug: string },
    live: boolean,
  ): void => {
    targets.set(targetKey(type, row.id), {
      href: `/ticket/${row.slug}`,
      label: row.name,
      live,
    });
  };
  for (const row of listingRows) {
    // Reachable ⇔ the ticket route would serve it: active and not a child.
    setLeaf("listing", row, row.active !== 0 && !childIds.has(row.id));
  }
  const groupLive = await mapParallel(async (row: { id: number }) =>
    groupHasBookableMember(await getActiveListingsByGroupId(row.id)),
  )(groupRows);
  groupRows.forEach((row, i) => {
    setLeaf("group", row, groupLive[i]!);
  });
  return targets;
};

/** Build the public nav view model for the current target (`null` on the fixed
 * pages — home, listings, order, terms, contact — which show just the root
 * row). With no current target there is no active chain, so no submenu level
 * can render a leaf: skip the leaf resolution entirely and keep the hot fixed
 * pages to the two cached reads. */
export const publicNavModel = async (
  current: TargetKey | null,
): Promise<NavModel> => {
  const [pages, items] = await Promise.all([
    getSitePageNavRows(),
    getAllPageItems(),
  ]);
  const targets = current === null ? new Map() : await resolveTargets(items);
  return buildNavModel(buildForest(pages, items), targets, current);
};

/** The full prop set {@link PublicNav} renders: the settings-driven page flags
 * plus the site-pages tree — built once per request by each public handler. */
export const publicNavProps = async (
  current: TargetKey | null,
): Promise<PublicNavProps> => ({
  ...navFlags(),
  pages: await publicNavModel(current),
});
