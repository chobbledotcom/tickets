/**
 * Scan handler for signed booking QR links.
 *
 * Verifies a signed token; on success, either skips straight to Stripe
 * checkout (when the token carries a name + value and the listing requires
 * no extra fields or questions) or renders the normal booking page
 * with the token's values pre-filled.
 */

import { isRegistrationClosed } from "#routes/format.ts";
import { htmlResponse } from "#routes/response.ts";
import { getBookableStartDates } from "#shared/dates.ts";
import { getGroupRemainingForListing } from "#shared/db/attendees/capacity.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { getListingWithCountBySlug } from "#shared/db/listings.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import { listingSupportsDirectCheckout } from "#shared/qr.ts";
import { type QrBookPayload, verifyQrBookToken } from "#shared/qr-token.ts";
import type { ListingWithCount } from "#shared/types.ts";
import {
  buildTicketListing,
  type QrPrefill,
  qrBookErrorPage,
  type TicketPrefill,
} from "#templates/public.tsx";
import {
  anyChildListing,
  getTicketContext,
  runCheckoutFlow,
} from "./ticket-payment.ts";
import { handleTicket } from "./ticket-submit.ts";

const errorResponse = (slug: string, status: number): Response =>
  htmlResponse(qrBookErrorPage(slug), status);

/** Build per-listing prefill entries from a QR payload */
const buildListingPrefills = (
  listing: ListingWithCount,
  payload: QrBookPayload,
): Map<number, TicketPrefill> => {
  const entry: TicketPrefill = { quantity: payload.q };
  if (payload.v >= 0 && listing.can_pay_more) {
    entry.customPriceMinor = payload.v;
  }
  return new Map([[listing.id, entry]]);
};

/** Build the QrPrefill context for the ticket page */
const buildPrefill = (
  listing: ListingWithCount,
  payload: QrBookPayload,
  token: string,
): QrPrefill => ({
  date: payload.d || undefined,
  listings: buildListingPrefills(listing, payload),
  name: payload.n || undefined,
  token,
});

/** Check whether the scan should skip straight to Stripe checkout.
 * Pre-requisites enforced by the caller: listing is loaded, and for daily
 * listings the payload date has been validated against bookable dates. */
const canSkipToCheckout = async (
  listing: ListingWithCount,
  payload: QrBookPayload,
): Promise<boolean> => {
  if (!payload.n || payload.v < 0) return false;
  // Customisable listings are priced by a chosen day count, so the visitor must
  // pass through the booking form to select it — never skip to a fixed price.
  if (listing.customisable_days) return false;
  return await listingSupportsDirectCheckout(listing);
};

/** Validate a daily-listing booking date against available dates (minus holidays).
 * Customisable listings use single-day availability — the chosen span is picked
 * on the booking form — so an individually-bookable start isn't over-restricted. */
const isDailyDateBookable = async (
  listing: ListingWithCount,
  date: string,
): Promise<boolean> => {
  if (!date) return false;
  const holidays = await getActiveHolidays();
  return getBookableStartDates(listing, holidays).includes(date);
};

/** Construct a CheckoutIntent for a single-listing direct-to-Stripe booking */
const buildCheckoutIntent = (
  listing: ListingWithCount,
  payload: QrBookPayload,
): CheckoutIntent => ({
  address: "",
  date: listing.listing_type === "daily" ? payload.d : null,
  email: "",
  items: [
    {
      listingId: listing.id,
      name: listing.name,
      quantity: payload.q,
      slug: listing.slug,
      unitPrice: payload.v,
    },
  ],
  name: payload.n,
  phone: "",
  special_instructions: "",
});

/** Redirect directly to Stripe checkout using the signed values */
const skipToCheckout = (
  request: Request,
  listing: ListingWithCount,
  payload: QrBookPayload,
): Promise<Response> => {
  const intent = buildCheckoutIntent(listing, payload);
  return runCheckoutFlow(
    `qr-book listing=${listing.id}`,
    request,
    (provider, baseUrl) => provider.createCheckoutSession(intent, baseUrl),
    () => errorResponse(listing.slug, 500),
  );
};

/** Once the token is verified and the listing loaded, render or redirect */
const dispatchVerified = async (
  request: Request,
  slug: string,
  token: string,
  payload: QrBookPayload,
  listing: ListingWithCount,
): Promise<Response> => {
  if (
    listing.listing_type === "daily" &&
    !(await isDailyDateBookable(listing, payload.d))
  ) {
    return errorResponse(slug, 400);
  }
  if (await canSkipToCheckout(listing, payload)) {
    return skipToCheckout(request, listing, payload);
  }
  const ticketListing = buildTicketListing(
    listing,
    isRegistrationClosed(listing),
    await getGroupRemainingForListing(listing),
  );
  const prefill = buildPrefill(listing, payload, token);
  return handleTicket({
    getContext: getTicketContext,
    listings: [ticketListing],
    prefill,
    request,
    slugs: [slug],
  });
};

/** GET /ticket/:slug/qr-book */
export const handleQrBookGet = async (
  request: Request,
  params: { slug: string },
): Promise<Response> => {
  const { slug } = params;
  const token = new URL(request.url).searchParams.get("t") ?? "";
  if (!token) return errorResponse(slug, 400);
  const payload = await verifyQrBookToken(slug, token);
  if (!payload) return errorResponse(slug, 400);
  const listing = await getListingWithCountBySlug(slug);
  if (!listing?.active) return errorResponse(slug, 404);
  // A booking can never start from a child (invariant I3): a signed QR for a
  // child would otherwise skip straight to checkout for it alone.
  if (await anyChildListing([listing.id])) return errorResponse(slug, 404);
  return dispatchVerified(request, slug, token, payload, listing);
};
