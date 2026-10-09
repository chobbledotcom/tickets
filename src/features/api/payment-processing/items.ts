/**
 * Validate every signed line of a paid order against the CURRENT database:
 * confirm each listing still accepts registrations, and compute its expected
 * price. Fail the whole order closed to a price_changed refund when the
 * package structure, a required child-edge, or a non-standalone flag drifted
 * mid-checkout.
 */

import { belowMinError } from "#booking/min-refusal.ts";
import {
  bookedOutsideParent,
  lineGroupId,
  standaloneLineListingIds,
} from "#booking/signed-metadata.ts";
import { t } from "#i18n";
/* jscpd:ignore-start -- import block */
import {
  anyPackageBundleMismatch,
  expectedItemPrice,
  hasStaleStandaloneChildFromFacts,
  orderEdgeDriftedFromFacts,
  type ValidatedItem,
} from "#routes/api/payment-processing/package-pricing.ts";
import { validationFailure } from "#routes/api/payment-processing/refunds.ts";
import type { PaidOrderSnapshot } from "#routes/api/payment-processing/snapshot/types.ts";
import type {
  ListingValidation,
  PaymentFailureResult,
} from "#routes/api/webhook-types.ts";
import { isRegistrationClosed } from "#routes/format.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";
import { allocatedChildIds } from "#shared/child-parents.ts";
import { hasNamedBookingPath } from "#shared/package-privacy.ts";
import type { ValidatedPaymentSession } from "#shared/payments.ts";
import type { ListingWithCount } from "#types";

/* jscpd:ignore-end */

/** Judge one already-loaded line against the current listing: gone, closed,
 * below a minimum the owner raised after checkout started, or good to
 * price. */
const validateListingForPayment = (
  listing: ListingWithCount,
  name: string,
  quantity: number,
): ListingValidation => {
  if (!listing.active) {
    return {
      error: name
        ? `${name} is no longer accepting registrations.`
        : "This listing is no longer accepting registrations.",
      ok: false,
      status: 410,
    };
  }
  if (isRegistrationClosed(listing)) {
    return {
      error: name
        ? `Sorry, registration for ${name} closed while you were completing payment.`
        : "Sorry, registration closed while you were completing payment.",
      ok: false,
      status: 410,
    };
  }
  // The buyer can open a paid checkout before the owner raises the
  // minimum. The webhook is the last stop, so it re-reads the stored fact.
  // The payment route loads this group for every request.
  const belowMinimum = belowMinError(
    quantity,
    listing.min_quantity,
    name
      ? t("payment.failure.below_minimum_named", {
          min_quantity: listing.min_quantity,
          name,
        })
      : t("payment.failure.below_minimum", {
          min_quantity: listing.min_quantity,
        }),
  );
  if (belowMinimum) {
    return { error: belowMinimum, ok: false, status: 410 };
  }
  return { listing, ok: true };
};

/** The name safe to show for one signed booking path. */
const buyerLineName = (
  intent: BookingIntent,
  snapshot: PaidOrderSnapshot,
): ((
  item: BookingIntent["items"][number],
  listing: ListingWithCount,
) => string) => {
  const allocations = intent.allocations ?? [];
  const outsideParent = bookedOutsideParent(allocations);
  const displays = snapshot.notificationPackages.displays;
  return (item, listing) => {
    const groupId = lineGroupId(item);
    if (groupId === undefined && outsideParent(item)) return listing.name;
    const groupIds =
      groupId === undefined
        ? intent.items
            .filter(
              (parent) =>
                parent.q > 0 &&
                allocations.some(
                  (allocation) =>
                    allocation.childId === item.e &&
                    allocation.parentId === parent.e,
                ),
            )
            .map((parent) => lineGroupId(parent) ?? 0)
        : [groupId];
    if (hasNamedBookingPath(displays, groupIds)) return listing.name;
    // Missing package facts must not reveal a member or its allocated child.
    return displays.get(groupIds[0] ?? 0)?.name ?? "";
  };
};

interface BookingPaths {
  allocations: NonNullable<BookingIntent["allocations"]>;
  foldedChildIds: Set<number>;
  standaloneLineIds: number[];
}

const bookingPaths = (intent: BookingIntent): BookingPaths => {
  const allocations = intent.allocations ?? [];
  // Parent listings with at least one package-tagged line. Children folded
  // under them book as part of some bundle.
  const taggedParentIds = new Set(
    intent.items
      .filter((item) => lineGroupId(item) !== undefined)
      .map((item) => item.e),
  );
  // Children folded under a tagged member book as part of that bundle.
  const bundledChildIds = allocatedChildIds(allocations, taggedParentIds);
  // Standalone-ness is judged per LINE, not per listing. An order can book
  // the same listing through a package AND its own row. The standalone path
  // must still take the stale checks below even though a tagged line shares
  // its listing id.
  const standaloneLineIds = standaloneLineListingIds(intent.items).filter(
    (id) => !bundledChildIds.has(id),
  );
  return {
    allocations,
    foldedChildIds: new Set(
      allocations.map((allocation) => allocation.childId),
    ),
    standaloneLineIds,
  };
};

/** The order's summed quantity per listing. The maximum is a per-booking rule
 *  on the listing. One order can book the same listing through several paths:
 *  a package line and its own row, or two overlapping packages. The webhook
 *  judges the sum, so two sub-limit lines cannot book past the cap together. */
const quantitiesByListingId = (
  items: BookingIntent["items"],
): Map<number, number> => {
  const totals = new Map<number, number>();
  for (const item of items) {
    totals.set(item.e, (totals.get(item.e) ?? 0) + item.q);
  }
  return totals;
};

/** The above-maximum refusal for one line's listing at the order's summed
 *  quantity, or null. The owner can lower the maximum while a checkout is
 *  open, and the webhook is the last stop that re-reads the stored fact. A
 *  folded daily child escapes the date-less maximum. foldChild skips that
 *  cap for daily children, and the folded per-date availability is the
 *  authority. */
const aboveMaximumRefusal = (
  listing: ListingWithCount,
  name: string,
  foldedDailyChildIds: ReadonlySet<number>,
  summedQuantity: number,
): { error: string; status: number } | null => {
  if (foldedDailyChildIds.has(listing.id)) return null;
  if (summedQuantity <= listing.max_quantity) return null;
  return {
    error: name
      ? t("payment.failure.above_maximum_named", {
          max_quantity: listing.max_quantity,
          name,
        })
      : t("payment.failure.above_maximum", {
          max_quantity: listing.max_quantity,
        }),
    status: 410,
  };
};

/** The folded children whose listings are daily: the only lines that escape
 *  the date-less maximum. */
const foldedDailyChildIds = (
  foldedChildIds: ReadonlySet<number>,
  listingsById: ReadonlyMap<number, ListingWithCount>,
): Set<number> =>
  new Set(
    [...foldedChildIds].filter(
      (id) => listingsById.get(id)?.listing_type === "daily",
    ),
  );

/** Whether the order carries a non-standalone child whose line outgrows what
 *  its allocations cover: the per-child surplus the fold never booked. A
 *  bookable-alone child beside its member parent books one aggregated line.
 *  The surplus read runs whenever the order carries any standalone line OR
 *  any folded allocation. Only a pure member-only order skips its read. */
const hasStaleChildSurplus = (
  intent: BookingIntent,
  snapshot: PaidOrderSnapshot,
  standaloneLineIds: readonly number[],
  allocations: NonNullable<BookingIntent["allocations"]>,
): boolean =>
  (standaloneLineIds.length > 0 || allocations.length > 0) &&
  hasStaleStandaloneChildFromFacts(
    intent,
    new Set(
      intent.items.flatMap((item) => {
        const listing = snapshot.listingsById.get(item.e);
        return listing &&
          !listing.bookable_alone &&
          (snapshot.parentsByChildId.get(item.e)?.length ?? 0) > 0
          ? [item.e]
          : [];
      }),
    ),
    snapshot.parentsByChildId,
  );

export const validateAllItems = async (
  session: ValidatedPaymentSession,
  intent: BookingIntent,
  snapshot: PaidOrderSnapshot,
): Promise<{ ok: true; items: ValidatedItem[] } | PaymentFailureResult> => {
  const { allocations, foldedChildIds, standaloneLineIds } =
    bookingPaths(intent);
  const pricingByGroup = snapshot.notificationPackages.pricingByGroup;
  const staleNonStandaloneChild = hasStaleChildSurplus(
    intent,
    snapshot,
    standaloneLineIds,
    allocations,
  );
  const listingsById = snapshot.listingsById;
  const nameFor = buyerLineName(intent, snapshot);
  const quantities = quantitiesByListingId(intent.items);
  const dailyFoldedIds = foldedDailyChildIds(foldedChildIds, listingsById);
  const validatedItems: ValidatedItem[] = [];
  for (const item of intent.items) {
    const listing = listingsById.get(item.e);
    if (!listing) {
      return validationFailure(
        session,
        { error: "Listing not found", status: 404 },
        item.e,
      );
    }
    const name = nameFor(item, listing);
    const vp = validateListingForPayment(listing, name, item.q);
    if (!vp.ok) return validationFailure(session, vp, item.e);
    const maxRefusal = aboveMaximumRefusal(
      listing,
      name,
      dailyFoldedIds,
      // The sum map is built from this same items list, so the lookup holds.
      quantities.get(item.e)!,
    );
    if (maxRefusal) return validationFailure(session, maxRefusal, item.e);
    const itemGroupId = lineGroupId(item);
    // `null` here means "fail closed" (the line is no longer a valid package
    // member). It is carried through so the price-mismatch pass refunds it
    // via the normal stored-placeholder path.
    validatedItems.push({
      expectedPrice: expectedItemPrice(
        itemGroupId === undefined ? undefined : pricingByGroup.get(itemGroupId),
        itemGroupId,
        foldedChildIds,
        item,
        vp.listing,
        intent.dayCount ?? 1,
      ),
      item,
      listing: vp.listing,
      name,
    });
  }
  // Order-level package check: if any bundle's signed lines no longer match
  // its current membership, fail every line closed. Current membership
  // changes when a member is added or removed, or when quantities no longer
  // share one package count. The whole order then takes the price_changed
  // refund rather than booking a partial or stale bundle.
  if (
    staleNonStandaloneChild ||
    anyPackageBundleMismatch(pricingByGroup, intent.items) ||
    orderEdgeDriftedFromFacts(intent, validatedItems, pricingByGroup, {
      childIdsByParent: snapshot.childrenByParentId,
      listingsById: snapshot.listingsById,
    })
  ) {
    return {
      items: validatedItems.map((v) => ({ ...v, expectedPrice: null })),
      ok: true,
    };
  }
  return { items: validatedItems, ok: true };
};
