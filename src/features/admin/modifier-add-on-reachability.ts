/** The child-add-on reachability check shared by modifier input validation and
 * the links-save guard. It answers one question about candidate listing or
 * group links: can an opt-in add-on be reached only through a suppressed
 * child? */

import { listingGroups } from "#db/groups/table.ts";
import { getNonStandaloneChildIds } from "#db/listing-parents.ts";
import { getAllListings } from "#db/listings/records.ts";
import {
  childUnreachableAddOnError,
  type ListingGroupMembership,
  listingIdsInGroups,
  reachablePageIds,
  toListingGroupMembership,
} from "#db/modifier-resolve.ts";
import type { ModifierScope, ModifierTrigger } from "#shared/price-modifier.ts";

const resolveAddOnScope = (
  scope: ModifierScope | undefined,
  listingIds: number[],
  groupIds: number[],
  allListings: ListingGroupMembership[],
): number[] | null => {
  if (scope === "listings") return listingIds;
  if (scope === "groups") return listingIdsInGroups(groupIds, allListings);
  return null;
};

type AddOnSaveCandidate = {
  active: boolean;
  trigger: ModifierTrigger;
  name: string;
  scope: ModifierScope | undefined;
  listingIds: number[];
  groupIds: number[];
};

/** The error message a links save or an input save earns when it leaves an
 * opt-in add-on reachable only through a suppressed child. Null when the
 * candidate stays reachable from a serving page. */
export const childAddOnSaveError = async (
  candidate: AddOnSaveCandidate,
): Promise<string | null> => {
  const allListings = await getAllListings();
  const allIds = allListings.map((listing) => listing.id);
  const [childIds, membership] = await Promise.all([
    getNonStandaloneChildIds(allIds),
    listingGroups.getIdsByKeys(allIds),
  ]);
  const membershipListings: ListingGroupMembership[] = allListings.map(
    (listing) => toListingGroupMembership(listing, membership),
  );
  // Only an ACTIVE listing that serves its own booking page can rescue a
  // child-only add-on. That is any active listing except a non-standalone
  // child. A `bookable_alone` child does serve its own page, so it counts.
  // Public ticket contexts load active listings only (`withActiveListings`),
  // so an inactive listing serves nothing. `childIds` here is the narrowed
  // non-standalone set, so a flagged child is neither suppressed nor excluded.
  const reachableIds = reachablePageIds(allListings, childIds);
  return childUnreachableAddOnError(
    {
      active: candidate.active,
      name: candidate.name,
      scope: resolveAddOnScope(
        candidate.scope,
        candidate.listingIds,
        candidate.groupIds,
        membershipListings,
      ),
      trigger: candidate.trigger,
    },
    childIds,
    reachableIds,
  );
};
