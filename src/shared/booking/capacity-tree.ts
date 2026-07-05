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

  const ticketsNeededByGroup = new Map<number, number>();
  for (const node of tree.nodes) {
    const q = perPackageQty(node);
    for (const groupId of groupIdsByListingId.get(node.listingId) ?? []) {
      if (!groupRemainingByGroupId.has(groupId)) continue;
      ticketsNeededByGroup.set(
        groupId,
        (ticketsNeededByGroup.get(groupId) ?? 0) + q,
      );
    }
  }
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
