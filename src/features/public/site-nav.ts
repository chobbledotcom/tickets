/**
 * Data-loading side of the public site-pages nav: load the forest's rows plus
 * the resolved leaf targets as plain data, then hand them to the pure
 * `buildNavModel`. The page/edge reads are the request-cached narrow
 * projections; leaf resolution runs only on `/page/:slug` renders (the fixed
 * pages pass a null current and skip it entirely).
 *
 * Liveness uses the same gates the rest of the public site does, so the nav
 * never renders a link that would 404 or dead-end. A listing is live iff it is
 * active, not a renewal tier (that flow needs a site token the normal ticket
 * flow never supplies), has its OWN standalone booking page (not a
 * non-standalone child, not a hidden package member — both 404 their
 * `/ticket/<slug>`), and is not a parent projected sold out. A group is live iff
 * its `/ticket/<group>` page would serve — a regular group needs a
 * standalone-bookable visible member, a package needs the whole bundle to fit
 * (the shared `groupBookable` gate, the same one the group card and QR use).
 * Being marked HIDDEN does not remove liveness: hidden governs the public index,
 * not bookability, so a hidden but bookable item an operator placed on a page
 * keeps its link (its page serves with noindex). Page targets are always live.
 */

import { filter, map, mapParallel, pipe, unique } from "#fp";
import { getHiddenPackageMemberIds, groups } from "#shared/db/groups.ts";
import { getListingsWithCountsByIds } from "#shared/db/listings.ts";
import { hasNewsPosts } from "#shared/db/news-posts.ts";
import { isQualifyingTierListing } from "#shared/site-assignment.ts";
import { buildNavModel, targetKey } from "#shared/site-pages/core.ts";
import { loadPageForest } from "#shared/site-pages/load.ts";
import type {
  NavModel,
  ResolvedTarget,
  TargetKey,
  TargetMap,
} from "#shared/site-pages/types.ts";
import type { Group, SitePageItem, SitePageItemType } from "#shared/types.ts";
import { navFlags, type PublicNavProps } from "#templates/public.tsx";
import {
  classifyForDiscovery,
  getVisibleGroupMembersByGroupIds,
  groupBookable,
} from "./discovery.ts";

/** The distinct item ids of one leaf type among the loaded edges. */
const leafIds = (
  items: readonly SitePageItem[],
  type: SitePageItemType,
): number[] =>
  pipe(
    filter((i: SitePageItem) => i.item_type === type),
    map((i: SitePageItem) => i.item_id),
    unique,
  )([...items]);

/** Resolve every referenced listing/group to its presentation + liveness. */
const resolveTargets = async (
  items: readonly SitePageItem[],
): Promise<TargetMap> => {
  const listingIds = leafIds(items, "listing");
  const groupIds = leafIds(items, "group");
  const [referenced, allGroups] = await Promise.all([
    getListingsWithCountsByIds(listingIds),
    groups.cache.getAll(),
  ]);
  const referencedGroups = allGroups.filter((group) =>
    groupIds.includes(group.id),
  );
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
  // A referenced listing is live iff its own booking page would serve: it is
  // active and not a renewal tier, has a standalone public page (not a
  // non-standalone child, not a hidden package member — both 404 their
  // /ticket/<slug>), and is not a parent the classifier projects sold out. One
  // classification over the referenced listings serves the whole set; it loads
  // each parent's children itself, so the sold-out projection is complete.
  const [{ nonStandaloneChildIds, soldOutParentIds }, hiddenMemberIds] =
    await Promise.all([
      referenced.length > 0
        ? classifyForDiscovery(referenced)
        : {
            nonStandaloneChildIds: new Set<number>(),
            soldOutParentIds: new Set<number>(),
          },
      getHiddenPackageMemberIds(listingIds),
    ]);
  const bookableLeaf = (listing: { id: number }): boolean =>
    !nonStandaloneChildIds.has(listing.id) &&
    !soldOutParentIds.has(listing.id) &&
    !hiddenMemberIds.has(listing.id);
  for (const listing of referenced) {
    setLeaf(
      "listing",
      listing,
      listing.active &&
        !isQualifyingTierListing(listing) &&
        bookableLeaf(listing),
    );
  }
  // A group is live iff its /ticket/<group> page would serve — the shared
  // groupBookable gate: a regular group needs one standalone-bookable visible
  // member, a package needs the whole bundle to fit. Matches what the /listings
  // group card and the group QR advertise, so the nav can't link to a dead page.
  // Members for every group are loaded in one batch so a page with many group
  // leaves does not run a member query per group (a package's own bundle-cap
  // read still runs per group inside groupBookable — that is per-package work).
  const membersByGroup =
    await getVisibleGroupMembersByGroupIds(referencedGroups);
  // getVisibleGroupMembersByGroupIds returns an entry for every group passed.
  const groupLive = await mapParallel((group: Group) =>
    groupBookable(group, membersByGroup.get(group.id)!),
  )(referencedGroups);
  for (const [index, group] of referencedGroups.entries()) {
    setLeaf("group", group, groupLive[index]!);
  }
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
  const { forest, items } = await loadPageForest();
  const targets = current === null ? new Map() : await resolveTargets(items);
  return buildNavModel(forest, targets, current);
};

/** The full prop set {@link PublicNav} renders: the settings-driven page
 * flags, the news flag (one cached indexed existence read — see
 * {@link hasNewsPosts}), and the site-pages tree — built once per request by
 * each public handler. */
export const publicNavProps = async (
  current: TargetKey | null,
): Promise<PublicNavProps> => ({
  ...navFlags(),
  hasNews: await hasNewsPosts(),
  pages: await publicNavModel(current),
});
