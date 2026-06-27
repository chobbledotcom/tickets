/**
 * Attendee-side parent/child persistence (booking metadata).
 *
 * A checkout that books a parent listing plus its chosen child add-ons creates
 * several `listing_attendees` rows under one attendee. This module annotates
 * those rows, purely additively, with two facts the booking flow already knows
 * implicitly:
 *
 *   - `orderToken` — one token shared by every row of the checkout, so the admin
 *     can group an order's rows back together.
 *   - `parentListingId` — for a folded child row, which parent listing the buyer
 *     chose it under.
 *
 * The pairing is RECOMPUTED from the persisted `listing_parents` edges and the
 * order's own booking set rather than threaded through the (cap-sensitive,
 * signed) paid round-trip: a child row's parent is the parent edge whose listing
 * is also booked in the same order. This runs identically for the free path and
 * the paid webhook path — both reach `createAttendeeAtomic` with the full folded
 * booking set (parents ∪ chosen children) — so neither needs parent-awareness.
 *
 * The unique index on `(listing_id, attendee_id, start_at)` folds a child chosen
 * under two parents into one row recording the first such parent. The operator's
 * main case is one parent → one child, so this is exact in practice and lossy
 * only in the documented rare multi-parent corner.
 */

import type {
  ChildAllocation,
  ListingBooking,
} from "#shared/db/attendee-types.ts";
import { getParentsForChildren } from "#shared/db/listing-parents.ts";

/** The first parent of each child that is itself booked in this order, keyed by
 * child listing id. Children with no in-order parent are omitted. */
const inOrderParentByChild = async (
  listingIds: readonly number[],
): Promise<Map<number, number>> => {
  const parentsByChild = await getParentsForChildren(listingIds);
  const bookedInOrder = new Set(listingIds);
  const result = new Map<number, number>();
  for (const [childId, parents] of parentsByChild) {
    const inOrderParent = parents.find((parent) =>
      bookedInOrder.has(parent.id),
    );
    if (inOrderParent) result.set(childId, inOrderParent.id);
  }
  return result;
};

/**
 * Annotate an order's bookings with a shared `orderToken` and each chosen
 * child's `parentListingId`, recomputed from the persisted parent/child edges.
 *
 * When no booked child has a parent also in the order, the bookings are returned
 * unchanged (token stays "", parent stays 0) so plain bookings carry no metadata
 * — keeping legacy rows and parent-less orders indistinguishable from before.
 *
 * Pre-expanded orders (from `expandChildAllocations`) already carry an
 * `orderToken` and exact `parentListingId`. This function skips recomputation
 * for those to preserve true multi-parent provenance.
 */
export const annotateOrderParents = async (
  bookings: ListingBooking[],
): Promise<ListingBooking[]> => {
  // Pre-expanded orders (expandChildAllocations path) already carry orderToken
  // and exact parentListingId. Skip the edge-based recomputation to preserve
  // true multi-parent provenance — recomputing would overwrite correct parent
  // ids with the lossy "first in-order parent" fallback.
  if (bookings.some((b) => b.orderToken)) return bookings;
  const parentByChild = await inOrderParentByChild(
    bookings.map((b) => b.listingId),
  );
  if (parentByChild.size === 0) return bookings;
  const orderToken = crypto.randomUUID();
  return bookings.map((booking) => ({
    ...booking,
    orderToken,
    ...(parentByChild.has(booking.listingId)
      ? { parentListingId: parentByChild.get(booking.listingId)! }
      : {}),
  }));
};

/**
 * Expand summed child bookings into per-parent rows using the true per-
 * `(child, parent)` allocations from the fold. Each allocation becomes one
 * `listing_attendees` row carrying its real `parentListingId`; parent rows
 * and standalone listings get only the shared `orderToken`. A shared UUID is
 * stamped on every row so the order can be grouped in admin views. Preserves
 * the proportional `pricePaid` across allocation rows (split by quantity ratio).
 *
 * This is the multi-parent-aware replacement for `annotateOrderParents`: where
 * the latter recomputes parentListingId as "first in-order parent" (lossy for
 * multi-parent), this function uses the allocation list to record the exact
 * parent for each unit. Used by the free path (Stage B); the paid path uses
 * the same function once the allocation is threaded through the round-trip
 * (Stage C).
 */
export const expandChildAllocations = (
  bookings: ListingBooking[],
  allocations: ChildAllocation[],
): ListingBooking[] => {
  const orderToken = crypto.randomUUID();
  const allocByChild = new Map<number, { parentId: number; qty: number }[]>();
  for (const alloc of allocations) {
    const list = allocByChild.get(alloc.childId) ?? [];
    list.push({ parentId: alloc.parentId, qty: alloc.qty });
    allocByChild.set(alloc.childId, list);
  }
  const result: ListingBooking[] = [];
  for (const booking of bookings) {
    const childAllocs = allocByChild.get(booking.listingId);
    if (childAllocs) {
      const totalQty = booking.quantity ?? 1;
      for (const alloc of childAllocs) {
        result.push({
          ...booking,
          orderToken,
          parentListingId: alloc.parentId,
          quantity: alloc.qty,
          ...(booking.pricePaid !== undefined
            ? {
                pricePaid: Math.round(
                  (booking.pricePaid * alloc.qty) / totalQty,
                ),
              }
            : {}),
        });
      }
    } else {
      result.push({ ...booking, orderToken });
    }
  }
  return result;
};
