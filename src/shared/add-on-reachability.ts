/**
 * The would-be-set add-on reachability guards: the checks that recompute a
 * whole listing set with a pending change applied — a save's group move, a
 * bulk deactivation, or the group page's removal — and refuse the ones that
 * would orphan a child-scoped add-on. The per-edge walker lives in
 * `listings-actions.ts`; these are the set-wide ones it cannot see.
 */

import type { TxScope } from "#db/client.ts";
import { listingGroups } from "#db/groups/table.ts";
import {
  getNonStandaloneChildIds,
  listingIdsWithLinks,
  listingParents,
} from "#db/listing-parents.ts";
import { getAllListings } from "#db/listings/records.ts";
import {
  childOnlyAddOnNameWithScopes,
  childUnreachableAddOnError,
  type ListingGroupMembership,
  listingIdsInGroups,
  optionalAddOnsWithScopes,
  reachablePageIds,
  toListingGroupMembership,
} from "#db/modifier-resolve.ts";
import { modifierGroups } from "#db/modifiers.ts";
import type { ListingWithCount } from "#types";

/** The user-facing refusal a reachability guard returns, or null when the
 * change it judged is safe. */
export type GuardRefusal = Promise<string | null>;

/** Every listing as a {@link ListingGroupMembership} with a per-listing override
 * applied — the would-be group set or inactive state the save is about to
 * commit. One membership lookup feeds both would-be reachability checks. An
 * optional transaction reads the listings and memberships through it, so a
 * guard inside a write transaction judges the rows that transaction sees
 * rather than the committed ones another save has already changed. */
export const listingsWithGroups = async (
  override: (listing: ListingWithCount) => Partial<ListingGroupMembership>,
  tx?: TxScope,
): Promise<ListingGroupMembership[]> => {
  const all = await getAllListings(tx);
  const membership = await listingGroups.getIdsByKeys(
    all.map((l) => l.id),
    tx,
  );
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
 * their reachability computation can't drift. The optional transaction keeps
 * every read of the walk inside the caller's write transaction, so the second
 * of two concurrent page-removing writes sees the first one's rows and refuses.
 */
export const orphanedAddOnOverWouldBe = async (
  override: (listing: ListingWithCount) => Partial<ListingGroupMembership>,
  forceSuppressed: readonly number[] = [],
  tx?: TxScope,
): GuardRefusal => {
  const wouldBe = await listingsWithGroups(override, tx);
  const childIds = await getNonStandaloneChildIds(
    wouldBe.map((l) => l.id),
    tx,
  );
  for (const id of forceSuppressed) childIds.add(id);
  return firstChildUnreachableAddOnForListings(wouldBe, childIds, tx);
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
  tx?: TxScope,
): GuardRefusal =>
  orphanedAddOnOverWouldBe(
    (listing) => {
      const groupIds = wouldBeGroups.get(listing.id);
      return groupIds === undefined ? {} : { groupIds: [...groupIds] };
    },
    [],
    tx,
  );

/** Re-checks every add-on with ALL the targets inactive at once: one rescued
 * only by several group members together is still caught. Deactivation only —
 * an activation can only add reachable pages. */
export const deactivationOrphanedAddOnError = async (
  inactiveIds: ReadonlySet<number>,
  tx?: TxScope,
): GuardRefusal => {
  // Deactivation does not clear bookable_alone, so a flagged child's stored row
  // still reads `bookable_alone = 1` and getNonStandaloneChildIds keeps excluding
  // it from the suppressed set — yet taking its page offline removes the only
  // surface a child-only add-on could sell from. Force every deactivated flagged
  // child (a child of some parent whose flag is still set) into the suppressed
  // set, matching the edit-save path's untick guard.
  const ids = [...inactiveIds];
  const childLinks = await listingParents.getIdsByKeys(ids, tx);
  const childIds = listingIdsWithLinks(childLinks);
  const nonStandalone = await getNonStandaloneChildIds([...childIds], tx);
  // Apply the would-be inactive state of every target listing to the in-memory set.
  return orphanedAddOnOverWouldBe(
    (listing) => (inactiveIds.has(listing.id) ? { active: false } : {}),
    [...childIds].filter((id) => !nonStandalone.has(id)),
    tx,
  );
};

/** A {@link GroupScopeResolver} that expands each group-scoped modifier against
 * an in-memory listing set, so a caller can test reachability under a listing's
 * would-be `group_id` (which the live `modifier_groups`→`listings` join would
 * not yet reflect). It maps each modifier's linked group ids to the supplied
 * listings' ids via {@link listingIdsInGroups}. */
const inMemoryGroupScopeResolver =
  (allListings: ListingGroupMembership[], tx?: TxScope) =>
  async (groupScopedIds: number[]) => {
    const groupLinks = await modifierGroups.getIdsByKeys(groupScopedIds, tx);
    return new Map(
      [...groupLinks].map(([id, groupIds]) => [
        id,
        listingIdsInGroups(groupIds, allListings),
      ]),
    );
  };

/** The would-be add-on set: scopes resolved against in-memory listings, with
 * every scope read through the optional transaction. The shared starting point
 * of the two would-be reachability checks. */
const wouldBeAddOns = (allListings: ListingGroupMembership[], tx?: TxScope) =>
  optionalAddOnsWithScopes(inMemoryGroupScopeResolver(allListings, tx), tx);

/**
 * Like {@link childOnlyAddOnName}, but resolving add-on scopes against the
 * supplied in-memory listings (with the saved listing's would-be `group_id`
 * already applied), so a listing save that moves a parent out of the group a
 * child-only add-on is scoped to is caught before it orphans the add-on. The
 * optional transaction reads the scopes through it.
 */
export const childOnlyAddOnNameForListings = async (
  childId: number,
  parentPageListingIds: readonly number[],
  allListings: ListingGroupMembership[],
  tx?: TxScope,
): GuardRefusal =>
  childOnlyAddOnNameWithScopes(
    await wouldBeAddOns(allListings, tx),
    childId,
    parentPageListingIds,
  );

export const firstChildUnreachableAddOnForListings = async (
  allListings: ListingGroupMembership[],
  childListingIds: Set<number>,
  tx?: TxScope,
): GuardRefusal => {
  const { optional, scopes } = await wouldBeAddOns(allListings, tx);
  const reachable = reachablePageIds(allListings, childListingIds);
  for (const modifier of optional) {
    const error = childUnreachableAddOnError(
      {
        active: modifier.active,
        name: modifier.name,
        scope: scopes.get(modifier.id)!,
        trigger: modifier.trigger,
      },
      childListingIds,
      reachable,
    );
    if (error) return error;
  }
  return null;
};
