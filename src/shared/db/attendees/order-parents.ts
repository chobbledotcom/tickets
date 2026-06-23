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
 * The pairing is RECOMPUTED here from the persisted `listing_parents` edges and
 * the order's own booking set rather than threaded through the (cap-sensitive,
 * signed) paid round-trip: a child row's parent is the parent edge whose listing
 * is also booked in the same order. This runs identically for the free path and
 * the paid webhook path — both reach `createAttendeeAtomic` with the full folded
 * booking set (parents ∪ chosen children) — so neither needs parent-awareness.
 *
 * The unique index on `(listing_id, attendee_id, start_at)` means the fold sums
 * a child chosen under two parents into one row; that row records the first such
 * parent. The operator's main case is one parent → one child, so this is exact
 * in practice and lossy only in the documented rare multi-parent corner.
 */

import type { ListingBooking } from "#shared/db/attendee-types.ts";
import { getParentsForChildren } from "#shared/db/listing-parents.ts";

/** The first parent of each child that is itself booked in this order, keyed by
 * child listing id. Children with no in-order parent are omitted. */
const inOrderParentByChild = async (
  listingIds: readonly number[],
): Promise<Map<number, number>> => {
  const parentsByChild = await getParentsForChildren(listingIds);
  const inOrder = new Set(listingIds);
  const result = new Map<number, number>();
  for (const [childId, parents] of parentsByChild) {
    const parent = parents.find((p) => inOrder.has(p.id));
    if (parent) result.set(childId, parent.id);
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
 */
export const annotateOrderParents = async (
  bookings: ListingBooking[],
): Promise<ListingBooking[]> => {
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
