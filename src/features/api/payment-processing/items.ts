/**
 * Validate every signed line of a paid order against the CURRENT database:
 * confirm each listing still accepts registrations, compute its expected price,
 * and fail the whole order closed to a price_changed refund when the package
 * structure, a required child-edge, or a hidden/non-standalone flag drifted
 * mid-checkout.
 */

import {
  lineGroupId,
  lineGroupIds,
  standaloneLineListingIds,
} from "#booking/signed-metadata.ts";
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
import type { ValidatedPaymentSession } from "#shared/payments.ts";
import type { ListingWithCount } from "#types";

/* jscpd:ignore-end */

/** Judge one already-loaded line against the current listing: gone, closed, or
 * good to price. */
const validateListingForPayment = (
  listing: ListingWithCount | undefined,
  includeListingName: boolean,
): ListingValidation => {
  if (!listing) {
    return { error: "Listing not found", ok: false, status: 404 };
  }
  const name = includeListingName ? listing.name : undefined;
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
  return { listing, ok: true };
};

interface BookingPaths {
  allocations: NonNullable<BookingIntent["allocations"]>;
  foldedChildIds: Set<number>;
  standaloneLineIds: number[];
}

const bookingPaths = (intent: BookingIntent): BookingPaths => {
  const allocations = intent.allocations ?? [];
  // Parent listings with at least one package-tagged line; children folded
  // under them book as part of some bundle.
  const taggedParentIds = new Set(
    intent.items
      .filter((item) => lineGroupId(item) !== undefined)
      .map((item) => item.e),
  );
  // Children folded under a tagged member book as part of that bundle.
  const bundledChildIds = new Set(
    allocations
      .filter((allocation) => taggedParentIds.has(allocation.parentId))
      .map((allocation) => allocation.childId),
  );
  // Standalone-ness is judged per LINE, not per listing: an order may book
  // the same listing through a package AND its own row, and the standalone
  // path must still take the stale checks below even though a tagged line
  // shares its listing id.
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

/** Validate all booking items and return per-item pricing info or a failure result. */
export const validateAllItems = async (
  session: ValidatedPaymentSession,
  intent: BookingIntent,
  snapshot: PaidOrderSnapshot,
): Promise<{ ok: true; items: ValidatedItem[] } | PaymentFailureResult> => {
  const { allocations, foldedChildIds, standaloneLineIds } =
    bookingPaths(intent);
  // For a hidden package, a per-member failure message would reveal a member
  // name on /payment/success, so never include the listing name in those errors
  // (fail-safe resolution — see resolveNamesConcealed).
  const groupIds = [...lineGroupIds(intent.items)];
  const hiddenPackage = groupIds.some(
    (groupId) =>
      snapshot.notificationPackages.displays.get(groupId)?.hideListings ?? true,
  );
  // A standalone session started before its listing joined a HIDDEN package must
  // not book the now-hidden member: its /ticket/<slug> 404s and /t/<token> would
  // render the member name/details. Detected here, failed closed after pricing so
  // the order takes the price_changed refund instead of a leaking standalone
  // ticket. Lines booked through a package are that bundle's own members, so
  // only the order's standalone lines are checked.
  const staleHiddenMember = standaloneLineIds.some((listingId) =>
    snapshot.hiddenPackageMemberIds.has(listingId),
  );
  // Suppress per-member names in failure messages for BOTH hidden cases: a hidden
  // package intent, and a stale standalone session whose listing has since become
  // a hidden member (else a member closed/deactivated mid-checkout surfaces its
  // name on /payment/success before the stale-member refund below runs).
  const includeListingName =
    intent.items.length > 1 && !hiddenPackage && !staleHiddenMember;
  const pricingByGroup = snapshot.notificationPackages.pricingByGroup;
  // A folded child rides an UNTAGGED line that bundledChildIds removes from
  // standaloneLineIds wholesale, yet that one line can hold more units than
  // the package-tagged allocations cover (a bookable-alone child bought beside
  // its member parent books one aggregated line). hasStaleStandaloneChild
  // judges that per-child surplus itself, so consult it whenever the order
  // carries any standalone line OR any folded allocation — only a pure
  // member-only order skips its read.
  const staleNonStandaloneChild =
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
  const listingsById = snapshot.listingsById;
  const validatedItems: ValidatedItem[] = [];
  for (const item of intent.items) {
    const vp = validateListingForPayment(
      listingsById.get(item.e),
      includeListingName,
    );
    if (!vp.ok) return validationFailure(session, vp, item.e);
    const itemGroupId = lineGroupId(item);
    // `null` here means "fail closed" (the line is no longer a valid package
    // member); it is carried through so the price-mismatch pass refunds it via
    // the normal stored-placeholder path.
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
    });
  }
  // Order-level package check: if any bundle's signed lines no longer match its
  // current membership (member added/removed, or quantities no longer share one
  // package count), fail every line closed so the whole order takes the
  // price_changed refund rather than booking a partial/stale bundle.
  if (
    staleHiddenMember ||
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
