/**
 * The would-be-set add-on reachability guards: the checks that recompute a
 * whole listing set with a pending change applied — a save's group move, a
 * bulk deactivation, or the group page's removal — and refuse the ones that
 * would orphan a child-scoped add-on. The per-edge walker lives in
 * `listings-actions.ts`; these are the set-wide ones it cannot see.
 */

import { listingGroups } from "#db/groups/table.ts";
import {
  getNonStandaloneChildIds,
  listingIdsWithLinks,
  listingParents,
} from "#db/listing-parents.ts";
import { getAllListings } from "#db/listings/records.ts";
/* jscpd:ignore-start -- imports */
import {
  firstChildUnreachableAddOnForListings,
  type ListingGroupMembership,
  toListingGroupMembership,
} from "#db/modifier-resolve.ts";
import type { ListingWithCount } from "#types";
/* jscpd:ignore-end */

/** Every listing as a {@link ListingGroupMembership} with a per-listing override
 * applied — the would-be group set or inactive state the save is about to
 * commit. One membership lookup feeds both would-be reachability checks. */
export const listingsWithGroups = async (
  override: (listing: ListingWithCount) => Partial<ListingGroupMembership>,
): Promise<ListingGroupMembership[]> => {
  const all = await getAllListings();
  const membership = await listingGroups.getIdsByKeys(all.map((l) => l.id));
  return all.map((listing) => ({
    ...toListingGroupMembership(listing, membership),
    ...override(listing),
  }));
};

/**
 * Run the shared child-scoped-add-on reachability over a would-be listing set:
 * apply `override` (a save's inactive/group-move state) to the in-memory
 * listings, then treat `forceSuppressed` ids as non-standalone children even
 * when the DB still reads them otherwise (a just-cleared `bookable_alone` flag,
 * which the pending save hasn't committed yet). Being in the suppressed set also
 * drops those ids from the reachable pages. Returns the first orphaned add-on's
 * error, or null. Shared by the deactivation and false-transition guards so
 * their reachability computation can't drift.
 */
export const orphanedAddOnOverWouldBe = async (
  override: (listing: ListingWithCount) => Partial<ListingGroupMembership>,
  forceSuppressed: readonly number[] = [],
): Promise<string | null> => {
  const wouldBe = await listingsWithGroups(override);
  const childIds = await getNonStandaloneChildIds(wouldBe.map((l) => l.id));
  for (const id of forceSuppressed) childIds.add(id);
  return firstChildUnreachableAddOnForListings(wouldBe, childIds);
};

/** The add-on reachability check a listing save runs when it drops a group
 * (the group-only case of the listing form's untick guard): a member leaving a
 * group can be the only page a child-scoped add-on is reachable from.
 * `wouldBeGroups` holds each leaving listing's complete remaining group set,
 * and one walk judges all of them at once, however many were selected. Used
 * by the group page's remove form, so it cannot orphan an add-on the listing
 * edit form would have refused to untick. */
export const groupLeavingOrphanedAddOnError = (
  wouldBeGroups: ReadonlyMap<number, readonly number[]>,
): Promise<string | null> =>
  orphanedAddOnOverWouldBe((listing) => {
    const groupIds = wouldBeGroups.get(listing.id);
    return groupIds === undefined ? {} : { groupIds: [...groupIds] };
  });

/** Re-checks every add-on with ALL the targets inactive at once: one rescued
 * only by several group members together is still caught. Deactivation only —
 * an activation can only add reachable pages. */
export const deactivationOrphanedAddOnError = async (
  inactiveIds: ReadonlySet<number>,
): Promise<string | null> => {
  // Deactivation does not clear bookable_alone, so a flagged child's stored row
  // still reads `bookable_alone = 1` and getNonStandaloneChildIds keeps excluding
  // it from the suppressed set — yet taking its page offline removes the only
  // surface a child-only add-on could sell from. Force every deactivated flagged
  // child (a child of some parent whose flag is still set) into the suppressed
  // set, matching the edit-save path's untick guard.
  const ids = [...inactiveIds];
  const childLinks = await listingParents.getIdsByKeys(ids);
  const childIds = listingIdsWithLinks(childLinks);
  const nonStandalone = await getNonStandaloneChildIds([...childIds]);
  // Apply the would-be inactive state of every target listing to the in-memory set.
  return orphanedAddOnOverWouldBe(
    (listing) => (inactiveIds.has(listing.id) ? { active: false } : {}),
    [...childIds].filter((id) => !nonStandalone.has(id)),
  );
};
