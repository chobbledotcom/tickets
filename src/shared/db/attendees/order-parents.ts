/**
 * The annotation is purely additive: an `orderToken` shared by the whole
 * checkout, and a `parentListingId` naming which parent a folded child was
 * chosen under.
 *
 * The pairing is recomputed from the persisted edges and the order's own
 * booking set, so neither the free nor the paid path needs parent-awareness.
 *
 * The unique index keeps the same child chosen under two parents as two rows.
 * A unit bought without a parent gets a parent-less remainder row.
 */

import type { ChildAllocation, ListingBooking } from "#db/attendee-types.ts";
import { listingParents } from "#db/listing-parents.ts";
import { reduce } from "#fp";

/** The first parent of each child that is itself booked in this order, keyed by
 * child listing id. Children with no in-order parent are omitted. */
const inOrderParentByChild = async (
  listingIds: readonly number[],
  suppliedParents?: ReadonlyMap<number, readonly number[]>,
): Promise<Map<number, number>> => {
  const parentsByChild =
    suppliedParents ?? (await listingParents.getIdsByKeys(listingIds));
  const bookedInOrder = new Set(listingIds);
  return reduce((result, [childId, parentIds]: [number, readonly number[]]) => {
    const inOrderParent = parentIds.find((parentId) =>
      bookedInOrder.has(parentId),
    );
    return inOrderParent === undefined
      ? result
      : result.set(childId, inOrderParent);
  }, new Map<number, number>())([...parentsByChild]);
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
  parentsByChild?: ReadonlyMap<number, readonly number[]>,
): Promise<ListingBooking[]> => {
  // Pre-expanded orders (expandChildAllocations path) already carry orderToken
  // and exact parentListingId. Skip the edge-based recomputation to preserve
  // true multi-parent provenance — recomputing would overwrite correct parent
  // ids with the lossy "first in-order parent" fallback.
  if (bookings.some((b) => b.orderToken)) return bookings;
  const parentByChild = await inOrderParentByChild(
    bookings.map((b) => b.listingId),
    parentsByChild,
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
  const allocatedQty = childAllocs.reduce((sum, a) => sum + a.qty, 0);
  const totalQty =
    booking.quantity === undefined ? allocatedQty : booking.quantity;
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
 * `pricePaid` is preserved exactly across the split rows (see
 * {@link splitPricePaid}), so splitting never loses or invents money.
 *
 * Unlike {@link annotateOrderParents}, which recomputes `parentListingId` as
 * "first in-order parent" and so is lossy for multi-parent, this records the
 * exact parent for each unit from the allocation list.
 */
export const expandChildAllocations = <T extends ListingBooking>(
  bookings: T[],
  allocations: ChildAllocation[],
): T[] => {
  const orderToken = crypto.randomUUID();
  const allocByChild = Map.groupBy(allocations, ({ childId }) => childId);
  return bookings.flatMap((booking) =>
    expandBooking(booking, allocByChild.get(booking.listingId), orderToken),
  );
};
