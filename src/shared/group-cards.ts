// effects: pure
/**
 * What the group cards dashboard shows. Each group shows as one card with its
 * listings on sale. The listings on sale in no group show after the cards.
 *
 * A group shows while one of its listings is on sale, or while it has no
 * listing yet. A group whose listings are all switched off is over, and stays
 * on the Groups page.
 */

import { requiredMapValue } from "#fp";
import { idSet } from "#shared/fp-records.ts";
import type { Group, ListingWithCount } from "#types";

/** What the admin home page shows: one table of every listing, or one card
 * for each group. */
export type DashboardType = "listings" | "groups";

/** The `view` value that asks for the listings table. */
export const LISTINGS_TABLE_VIEW = "listings";

/** Whether `/admin/` shows the group cards: the owner chose them, and this
 * request did not ask for the listings table. */
export const showsGroupCards = (
  dashboardType: DashboardType,
  view: string | null,
): boolean => dashboardType === "groups" && view !== LISTINGS_TABLE_VIEW;

export interface GroupCard {
  readonly group: Group;
  /** The group's listings on sale, in the dashboard's listing order. */
  readonly listings: readonly ListingWithCount[];
}

export interface GroupCards {
  readonly cards: readonly GroupCard[];
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

/** One card per group that still sells or has no listing yet. */
const cardsOf = ({ groups, listings, members }: DashboardGroups): GroupCard[] =>
  groups.flatMap((group) => {
    const groupMembers = requiredMapValue(members, group.id);
    const onSale = keepListingsInGroup(listings, idSet(groupMembers));
    return groupMembers.length === 0 || onSale.length > 0
      ? [{ group, listings: onSale }]
      : [];
  });

/** Sort the dashboard's listings into group cards and the listings in no
 * group. */
export const groupCardsOf = (known: DashboardGroups): GroupCards => {
  const onSale = known.listings.filter((listing) => listing.active);
  const grouped = idSet([...known.members.values()].flat());
  return {
    cards: cardsOf({ ...known, listings: onSale }),
    otherListings: onSale.filter((listing) => !grouped.has(listing.id)),
  };
};
