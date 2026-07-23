/**
 * Validate every signed line of a paid order against the CURRENT database:
 * confirm each listing still accepts registrations, compute its expected price,
 * and fail the whole order closed to a price_changed refund when the package
 * structure, a required child-edge, or a hidden/non-standalone flag drifted
 * mid-checkout.
 */

import {
  anyPackageBundleMismatch,
  expectedItemPrice,
  hasStaleStandaloneChild,
  loadPackagePricingByGroup,
  orderEdgeDrifted,
  type ValidatedItem,
} from "#routes/api/payment-processing/package-pricing.ts";
import { validationFailure } from "#routes/api/payment-processing/refunds.ts";
import type {
  BookingIntent,
  ListingValidation,
  PaymentFailureResult,
} from "#routes/api/webhook-types.ts";
import { isRegistrationClosed } from "#routes/format.ts";
import {
  lineGroupId,
  lineGroupIds,
  standaloneLineListingIds,
} from "#shared/booking/signed-metadata.ts";
import { getHiddenPackageMemberIds } from "#shared/db/groups.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { resolveNamesConcealed } from "#shared/package-privacy.ts";
import type { ValidatedPaymentSession } from "#shared/payments.ts";

/** Load a listing by ID or return a 404 "Listing not found" error payload. */
const loadListingOr404 = async (
  listingId: number,
): Promise<
  | {
      ok: true;
      listing: NonNullable<Awaited<ReturnType<typeof getListingWithCount>>>;
    }
  | { ok: false; error: string; status: 404 }
> => {
  const listing = await getListingWithCount(listingId);
  if (!listing) {
    return { error: "Listing not found", ok: false, status: 404 };
  }
  return { listing, ok: true };
};

const validateListingForPayment = async (
  listingId: number,
  includeListingName = false,
): Promise<ListingValidation> => {
  const loaded = await loadListingOr404(listingId);
  if (!loaded.ok) return loaded;
  const listing = loaded.listing;
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
): Promise<{ ok: true; items: ValidatedItem[] } | PaymentFailureResult> => {
  const { allocations, foldedChildIds, standaloneLineIds } =
    bookingPaths(intent);
  // For a hidden package, a per-member failure message would reveal a member
  // name on /payment/success, so never include the listing name in those errors
  // (fail-safe resolution — see resolveNamesConcealed).
  const hiddenPackage = await resolveNamesConcealed(lineGroupIds(intent.items));
  // A standalone session started before its listing joined a HIDDEN package must
  // not book the now-hidden member: its /ticket/<slug> 404s and /t/<token> would
  // render the member name/details. Detected here, failed closed after pricing so
  // the order takes the price_changed refund instead of a leaking standalone
  // ticket. Lines booked through a package are that bundle's own members, so
  // only the order's standalone lines are checked.
  const staleHiddenMember =
    standaloneLineIds.length > 0 &&
    (await getHiddenPackageMemberIds(standaloneLineIds)).size > 0;
  // Suppress per-member names in failure messages for BOTH hidden cases: a hidden
  // package intent, and a stale standalone session whose listing has since become
  // a hidden member (else a member closed/deactivated mid-checkout surfaces its
  // name on /payment/success before the stale-member refund below runs).
  const includeListingName =
    intent.items.length > 1 && !hiddenPackage && !staleHiddenMember;
  const pricingByGroup = await loadPackagePricingByGroup(intent);
  // A folded child rides an UNTAGGED line that bundledChildIds removes from
  // standaloneLineIds wholesale, yet that one line can hold more units than
  // the package-tagged allocations cover (a bookable-alone child bought beside
  // its member parent books one aggregated line). hasStaleStandaloneChild
  // judges that per-child surplus itself, so consult it whenever the order
  // carries any standalone line OR any folded allocation — only a pure
  // member-only order skips its read.
  const staleNonStandaloneChild =
    (standaloneLineIds.length > 0 || allocations.length > 0) &&
    (await hasStaleStandaloneChild(intent));
  const validatedItems: ValidatedItem[] = [];
  for (const item of intent.items) {
    const vp = await validateListingForPayment(item.e, includeListingName);
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
    (await orderEdgeDrifted(intent, validatedItems, pricingByGroup))
  ) {
    return {
      items: validatedItems.map((v) => ({ ...v, expectedPrice: null })),
      ok: true,
    };
  }
  return { items: validatedItems, ok: true };
};
