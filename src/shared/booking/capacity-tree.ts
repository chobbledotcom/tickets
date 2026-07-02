import {
  type BookingNode,
  type BookingTree,
  nodeFixedQuantity,
} from "#shared/booking/tree.ts";
import {
  groupPoolUnits,
  type TicketListing,
} from "#templates/public/shared.tsx";

/**
 * Tree-driven booking capacity (Phase 2c). The authoritative overbooking guard is
 * the atomic write predicate (`buildCapacityCondition`) and its byte-identical
 * read preflight (`buildBatchCapacitySql`) — this module only computes the
 * render/submit **clamp** shown to the buyer, with those SQL gates as the backstop.
 * `groupPoolUnits` (floor(remaining/demand)) is the shared leaf across every cap.
 */

/** The most whole packages that fit, driven by the booking tree: each top-level
 * `FIXED` package-member node carries its per-package quantity as its
 * `quantityRule`, so demand comes from the tree rather than a parallel quantity
 * map. Two bounds, the tighter wins:
 *  - **own cap** — each member's `floor(maxPurchasable / perPackageQty)`,
 *    additionally clamped by the member's required children's combined
 *    capacity (`childUnitsCapByListingId`, present only for parent members):
 *    each booked member unit consumes one child unit, so a bundle count the
 *    children can't serve must not be offered; and
 *  - **group pool** — for every capped group the members share,
 *    `groupPoolUnits(remaining, Σ per-package demand)` (a member counts its
 *    per-package quantity toward each capped group it sits in).
 *
 * `listingById` supplies each member's availability-resolved `maxPurchasable`;
 * every member node's listing is present by construction (the tree was built from
 * these listings). Returns 0 when no whole bundle fits (sold out). */
export const packageQuantityCap = (
  tree: BookingTree,
  listingById: ReadonlyMap<number, TicketListing>,
  groupRemainingByGroupId: ReadonlyMap<number, number>,
  groupIdsByListingId: ReadonlyMap<number, number[]>,
  childUnitsCapByListingId: ReadonlyMap<number, number> = new Map(),
): number => {
  const perPackageQty = nodeFixedQuantity;
  const ownCap = (node: BookingNode): number => {
    const own = listingById.get(node.listingId)!.maxPurchasable;
    const childUnits = childUnitsCapByListingId.get(node.listingId);
    const units = childUnits === undefined ? own : Math.min(own, childUnits);
    return Math.floor(units / perPackageQty(node));
  };
  const perMember = Math.min(...tree.nodes.map(ownCap));

  // Combined per-package demand against each capped group its members sit in.
  const demandByGroup = new Map<number, number>();
  for (const node of tree.nodes) {
    const q = perPackageQty(node);
    for (const groupId of groupIdsByListingId.get(node.listingId) ?? []) {
      if (!groupRemainingByGroupId.has(groupId)) continue; // uncapped
      demandByGroup.set(groupId, (demandByGroup.get(groupId) ?? 0) + q);
    }
  }
  let cap = perMember;
  for (const [groupId, demand] of demandByGroup) {
    cap = Math.min(
      cap,
      groupPoolUnits(groupRemainingByGroupId.get(groupId)!, demand),
    );
  }
  return cap;
};
