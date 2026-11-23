// effects: pure
/**
 * What the club night dashboard shows. Each night (a group) shows with its
 * listings on sale. The listings on sale in no group show after the nights.
 *
 * A group shows while one of its listings is on sale, or while it has no
 * listing yet. A group whose listings are all switched off is a past night,
 * and stays on the Groups page.
 */

import { requiredMapValue } from "#fp";
import { idSet } from "#shared/fp-records.ts";
import type { Group, ListingWithCount } from "#types";

/** The `view` value that asks for the full dashboard. */
export const FULL_DASHBOARD_VIEW = "full";

/** Whether `/admin/` shows the club night dashboard: the owner turned it on,
 * and this request did not ask for the full dashboard. */
export const showsClubNights = (
  turnedOn: boolean,
  view: string | null,
): boolean => turnedOn && view !== FULL_DASHBOARD_VIEW;

export interface ClubNight {
  readonly group: Group;
  /** The group's listings on sale, in the dashboard's listing order. */
  readonly listings: readonly ListingWithCount[];
}

export interface ClubNights {
  readonly nights: readonly ClubNight[];
  /** The listings on sale that are in no group, in the dashboard's order. */
  readonly otherListings: readonly ListingWithCount[];
}

/** The loaded listings that belong to the chosen group, in the loaded order. */
export const keepListingsInGroup = (
  listings: readonly ListingWithCount[],
  memberIds: ReadonlySet<number>,
): ListingWithCount[] =>
  listings.filter((listing) => memberIds.has(listing.id));

/** What the dashboard knows about its groups. `members` names every group's
 * listings, on sale or not. `listings` sets the order. */
export interface DashboardGroups {
  readonly groups: readonly Group[];
  readonly listings: readonly ListingWithCount[];
  readonly members: ReadonlyMap<number, readonly ListingWithCount[]>;
}

/** One night per group that still sells or has no listing yet. */
const nightsOf = ({
  groups,
  listings,
  members,
}: DashboardGroups): ClubNight[] =>
  groups.flatMap((group) => {
    const groupMembers = requiredMapValue(members, group.id);
    const onSale = keepListingsInGroup(listings, idSet(groupMembers));
    return groupMembers.length === 0 || onSale.length > 0
      ? [{ group, listings: onSale }]
      : [];
  });

/** Sort the dashboard's listings into nights and the listings in no group. */
export const clubNightsOf = (known: DashboardGroups): ClubNights => {
  const onSale = known.listings.filter((listing) => listing.active);
  const grouped = idSet([...known.members.values()].flat());
  return {
    nights: nightsOf({ ...known, listings: onSale }),
    otherListings: onSale.filter((listing) => !grouped.has(listing.id)),
  };
};
