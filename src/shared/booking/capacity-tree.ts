import { sumByKey } from "#fp";
import {
  type TicketListing,
  ticketsThatFitInPool,
} from "#shared/booking/model.ts";
import {
  type BookingNode,
  type BookingTree,
  nodeFixedQuantity,
} from "#shared/booking/tree.ts";

/**
 * Computes package limits from the booking tree.
 * The database still makes the final overbooking check; this only decides the
 * limit shown to the buyer and used when the form is submitted.
 */

/** Whole packages that fit after member, child, and shared-group limits. */
export const packageQuantityLimit = (
  tree: BookingTree,
  listingById: ReadonlyMap<number, TicketListing>,
  groupRemainingByGroupId: ReadonlyMap<number, number>,
  groupIdsByListingId: ReadonlyMap<number, number[]>,
  childLimitByListingId: ReadonlyMap<number, number>,
): number => {
  const perPackageQty = nodeFixedQuantity;
  const ownLimit = (node: BookingNode): number => {
    const own = listingById.get(node.listingId)!.maxPurchasable;
    const childLimit = childLimitByListingId.get(node.listingId);
    const tickets = childLimit === undefined ? own : Math.min(own, childLimit);
    return Math.floor(tickets / perPackageQty(node));
  };
  const perMember = Math.min(...tree.nodes.map(ownLimit));

  // Every (group this member shares, tickets it needs there) pair, dropping
  // groups with no remaining pool, then summed per group.
  const groupTickets = tree.nodes.flatMap((node) =>
    (groupIdsByListingId.get(node.listingId) ?? [])
      .filter((groupId) => groupRemainingByGroupId.has(groupId))
      .map((groupId) => ({ groupId, tickets: perPackageQty(node) })),
  );
  const ticketsNeededByGroup = sumByKey<
    { groupId: number; tickets: number },
    number
  >(
    (row) => row.groupId,
    (row) => row.tickets,
  )(groupTickets);
  let limit = perMember;
  for (const [groupId, ticketsNeeded] of ticketsNeededByGroup) {
    limit = Math.min(
      limit,
      ticketsThatFitInPool(
        groupRemainingByGroupId.get(groupId)!,
        ticketsNeeded,
      ),
    );
  }
  return limit;
};
