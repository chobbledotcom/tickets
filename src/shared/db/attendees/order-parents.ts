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
 * The unique index on `(listing_id, attendee_id, start_at, parent_listing_id)`
 * keeps the SAME child chosen under two parents as two distinct rows (one per
 * parent, faithful provenance), so {@link expandChildAllocations} emits one row
 * per `(child, parent)` allocation. A child whose booked quantity exceeds its
 * summed allocations (units bought without a parent in the same order — only
 * reachable once a child listing is bookable on its own) also gets a parent-less
 * remainder row, so no unit — or its price — is ever dropped.
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

/** Split a booking's `pricePaid` across its output rows in quantity proportion,
 * with the LAST row absorbing the rounding residue so the booking's total is
 * conserved to the cent — an odd split (100 across three units → 33/33/34, not
 * 33/33/33) would otherwise lose or create a penny, drifting ledger/email
 * totals. Returns one price per row, or all-`undefined` when the booking carries
 * no price (a free line). */
const splitPricePaid = (
  total: number | undefined,
  quantities: readonly number[],
  bookingQty: number,
): (number | undefined)[] => {
  if (total === undefined) return quantities.map(() => undefined);
  let assigned = 0;
  return quantities.map((qty, i) => {
    const share =
      i === quantities.length - 1
        ? total - assigned
        : Math.round((total * qty) / bookingQty);
    assigned += share;
    return share;
  });
};

/** Expand one booking into its rows: one per `(child, parent)` allocation
 *  (carrying that parent), plus — for any units the allocations don't cover — a
 *  single parent-less remainder row. A booking with no allocation stays one
 *  standalone row. `pricePaid` is split across the rows by {@link splitPricePaid}.
 *
 *  Generic over `T extends ListingBooking` so a caller that carries extra
 *  required row fields through the booking keeps them on every expanded row —
 *  the spread copies all of `booking`'s own properties and only overrides the
 *  `ListingBooking`-compatible members (parent, quantity, price, token). The
 *  cast is the standard workaround for TypeScript's inability to prove a
 *  generic object spread is assignable back to its parameter; the spread
 *  structurally preserves `T`, so the assertion is sound. */
const expandBooking = <T extends ListingBooking>(
  booking: T,
  childAllocs: readonly { parentId: number; qty: number }[] | undefined,
  orderToken: string,
): T[] => {
  if (!childAllocs) return [{ ...booking, orderToken }] as T[];
  const totalQty = booking.quantity ?? 1;
  const allocatedQty = childAllocs.reduce((sum, a) => sum + a.qty, 0);
  const remainderQty = totalQty - allocatedQty;
  const rows: { parentId?: number; qty: number }[] = [
    ...childAllocs.map((a) => ({ parentId: a.parentId, qty: a.qty })),
    ...(remainderQty > 0 ? [{ qty: remainderQty }] : []),
  ];
  const prices = splitPricePaid(
    booking.pricePaid,
    rows.map((r) => r.qty),
    totalQty,
  );
  return rows.map((row, i) => ({
    ...booking,
    orderToken,
    quantity: row.qty,
    ...(row.parentId !== undefined ? { parentListingId: row.parentId } : {}),
    ...(prices[i] !== undefined ? { pricePaid: prices[i] } : {}),
  })) as T[];
};

/**
 * Expand summed child bookings into per-parent rows using the true per-
 * `(child, parent)` allocations from the fold. Each allocation becomes one
 * `listing_attendees` row carrying its real `parentListingId`; any un-allocated
 * units of a child (bought without a parent in this order) become one parent-less
 * remainder row; parent rows and standalone listings get only the shared
 * `orderToken`. A shared UUID is stamped on every row so the order can be grouped
 * in admin views. `pricePaid` is preserved exactly across the split rows (see
 * {@link splitPricePaid}).
 *
 * This is the multi-parent-aware replacement for `annotateOrderParents`: where
 * the latter recomputes parentListingId as "first in-order parent" (lossy for
 * multi-parent), this function uses the allocation list to record the exact
 * parent for each unit. Used by both the free path and the paid webhook path,
 * which thread the allocation through the round-trip. Generic over
 * `T extends ListingBooking` so any required row fields a caller carries on
 * each booking survive the expansion.
 */
export const expandChildAllocations = <T extends ListingBooking>(
  bookings: T[],
  allocations: ChildAllocation[],
): T[] => {
  const orderToken = crypto.randomUUID();
  const allocByChild = new Map<number, { parentId: number; qty: number }[]>();
  for (const alloc of allocations) {
    const list = allocByChild.get(alloc.childId) ?? [];
    list.push({ parentId: alloc.parentId, qty: alloc.qty });
    allocByChild.set(alloc.childId, list);
  }
  return bookings.flatMap((booking) =>
    expandBooking(booking, allocByChild.get(booking.listingId), orderToken),
  );
};
