/**
 * The canonical signed paid booking rows — one representation of what a
 * completed, correctly-priced order writes to `listing_attendees`, shared by
 * ordinary payment completion. The later staged-checkout runtime will reach
 * the same rows through the same builder, which is why the builder is pure
 * over its inputs (the only impurity is the single order-token UUID the
 * expansion mints, mirroring the in-memory token main's rows already share).
 *
 * Behaviour kept identical to main's paid webhook path:
 *  - one row per signed line, carrying listing, quantity, date, duration,
 *    package path, and paid price, in input order;
 *  - child allocations expand into one row per (child, parent), preserving
 *    total quantity and exact total paid price (the last split row absorbs
 *    the rounding residue) and sharing one order token;
 *  - a folded child is stamped with its parent's package ONLY when that parent
 *    books through exactly one path — mixed and standalone parent paths do
 *    not falsely stamp children;
 *  - a genuine `pricePaid: 0` (a free line that was still signed) is kept
 *    distinct from an omitted price, so the ledger never confuses "free"
 *    with "unpriced".
 */

import {
  soleParentPackageIds,
  stampChildRowPackages,
} from "#shared/booking/page-packages.ts";
import {
  type BookingDateSource,
  bookingDateFields,
} from "#shared/booking-date-fields.ts";
import type {
  ChildAllocation,
  ListingBooking,
} from "#shared/db/attendee-types.ts";
import { expandChildAllocations } from "#shared/db/attendees/order-parents.ts";
import type { CheckoutItem } from "#shared/payments.ts";

/** One signed paid line: the booking slot (listing id + package path), the
 *  quantity, the listing's date/duration facts, and the line's charged
 *  amount — everything {@link orderBookings} needs to build one canonical
 *  {@link ListingBooking} row before child-allocation expansion.
 *
 *  The slot's `packageGroupId` is `0` for a standalone line and the package's
 *  group id for a line booked through a package — the same `packageGroupId 0`
 *  contract the existing writers expect. `pricePaid` carries the distinction
 *  the ledger depends on: a genuine `0` stays `0`; an `undefined` line
 *  carries no price and is written to no row's `pricePaid`. */
export type SignedPaidLine = {
  listingId: number;
  packageGroupId: number;
  quantity: number;
  /** The listing facts that derive the row's `date`/`durationDays`. */
  listing: BookingDateSource;
  /** The line's charged amount in minor units, or `undefined` when the line
   *  carries no price. */
  pricePaid?: number;
};

/** Input to {@link orderBookings}: the signed paid lines plus the order's
 *  shared date, day count, and per-(child, parent) allocations. */
export type OrderBookingsInput = {
  lines: SignedPaidLine[];
  date: string | null;
  /** Visitor-chosen day count for "customisable days" listings. Absent or 1
   *  when no selected listing is customisable — modelled as optional to
   *  mirror the genuinely optional `BookingIntent.dayCount` (a legacy session
   *  without `day_count` still means one day via {@link bookingDateFields}'s
   *  default). Typed `number | undefined` (not bare `?: number`) so an
   *  intent's `dayCount` can be passed through directly under
   *  `exactOptionalPropertyTypes`. */
  dayCount?: number | undefined;
  /** Per-(child, parent) allocations from the fold, carried through the signed
   *  metadata. Absent or empty for legacy/no-parent orders. Typed
   *  `ChildAllocation[] | undefined` so an intent's `allocations` can be
   *  passed through directly under `exactOptionalPropertyTypes`. */
  allocations?: ChildAllocation[] | undefined;
};

export type CanonicalOrderBooking = ListingBooking & {
  durationDays: number;
  quantity: number;
};

/**
 * Build the canonical signed paid booking rows from a validated, priced order.
 *
 * Each line becomes one row carrying its listing, quantity, date, duration,
 * package path, and paid price; child lines expand into per-parent rows when
 * allocations are present; each folded child is stamped with its parent's
 * package only when that parent books through exactly one path (see
 * {@link soleParentPackageIds}). Preserves input order, exact total paid price
 * (the last split row absorbs the rounding residue), the `pricePaid: 0`
 * versus omitted distinction, and one shared order token across every
 * expanded row.
 */
export const orderBookings = (
  input: OrderBookingsInput,
): CanonicalOrderBooking[] => {
  const { lines, date, dayCount, allocations } = input;
  const rawBookings: CanonicalOrderBooking[] = lines.map((line) => ({
    listingId: line.listingId,
    packageGroupId: line.packageGroupId,
    quantity: line.quantity,
    ...bookingDateFields(line.listing, date, dayCount),
    ...(line.pricePaid !== undefined ? { pricePaid: line.pricePaid } : {}),
  }));
  return stampChildRowPackages(
    allocations && allocations.length > 0
      ? expandChildAllocations(rawBookings, allocations)
      : rawBookings,
    // soleParentPackageIds reads each line's package path; a SignedPaidLine
    // already carries packageGroupId (0 = standalone, dropped; N = a sole
    // package, kept), so the lines can be passed directly — matching main's
    // per-line package-group derivation.
    soleParentPackageIds(lines),
  );
};

/** Apply one order's shared date, day count, and child allocations to lines. */
export const bookingsForOrder = (
  order: Omit<OrderBookingsInput, "lines">,
  lines: SignedPaidLine[],
): CanonicalOrderBooking[] =>
  orderBookings({
    allocations: order.allocations,
    date: order.date,
    dayCount: order.dayCount,
    lines,
  });

/** Turn checkout items into canonical line inputs using their loaded listings. */
export const checkoutBookingLines = <T extends CheckoutItem>(
  items: T[],
  listingById: ReadonlyMap<number, BookingDateSource>,
  pricePaid?: ReadonlyMap<T, number>,
): SignedPaidLine[] =>
  items.map((item) => ({
    listing: listingById.get(item.listingId)!,
    listingId: item.listingId,
    packageGroupId: item.packageGroupId ?? 0,
    ...(pricePaid ? { pricePaid: pricePaid.get(item)! } : {}),
    quantity: item.quantity,
  }));
