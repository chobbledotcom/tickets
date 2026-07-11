import { apiError } from "#routes/api/cors.ts";
import { processParentApiBooking } from "#routes/api/folded-booking.ts";
import {
  bookingSuccessResponse,
  checkBookingRateLimit,
  checkoutFailedResponse,
  checkoutResponse,
  parseApiJsonBody,
  resolveCustomPrice,
  resolvePositiveQuantity,
  soldOutResponse,
  toFormParams,
  withActiveListing,
} from "#routes/api/helpers.ts";
import { isRegistrationClosed } from "#routes/format.ts";
import { parentRequiresChild } from "#routes/public/ticket-payment.ts";
import { getBaseUrl } from "#routes/url.ts";
import { bookingError } from "#shared/booking/form.ts";
import { processBooking } from "#shared/booking.ts";
import { countsPerDate } from "#shared/capacity-rules.ts";
import { getAvailableDates } from "#shared/dates.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { anyNonStandaloneChild } from "#shared/db/listing-parents.ts";
import { isPaidListing, type ListingWithCount } from "#shared/types.ts";
import {
  extractContact,
  tryValidateTicketFields,
} from "#templates/fields/ticket.ts";

/** Map a BookingResult to an API JSON response */
const bookingResultToResponse = (
  result: import("#shared/booking.ts").BookingResult,
): Response => {
  switch (result.type) {
    case "success":
      return bookingSuccessResponse(result.attendee);
    case "checkout":
      return checkoutResponse(result.checkoutUrl);
    case "sold_out":
      return soldOutResponse();
    case "checkout_failed":
      return checkoutFailedResponse(result.error);
    case "creation_failed":
      return result.reason === "capacity_exceeded"
        ? soldOutResponse()
        : apiError(bookingError.fallback, 500);
  }
};

/**
 * Resolve and validate the booking date for listings booked per date (a no-op
 * for date-less listings, whose capacity is one running total). Returns the
 * submitted date, null for date-less listings, or a 400 response when the date
 * is missing or unavailable.
 */
const resolveBookingDate = async (
  listing: ListingWithCount,
  body: Record<string, unknown>,
): Promise<string | null | Response> => {
  if (!countsPerDate(listing.listing_type)) return null;
  const submittedDate = String(body.date ?? "");
  const availableDates = getAvailableDates(listing, await getActiveHolidays());
  if (!submittedDate || !availableDates.includes(submittedDate)) {
    return apiError(bookingError.invalidDate);
  }
  return submittedDate;
};

/** Resolve a booking's quantity (clamped to the listing's per-order max) and its
 * date (validated for daily listings), or a 400 response for an invalid date.
 * Shared by the standalone and parent booking paths. */
const resolveQuantityAndDate = async (
  listing: ListingWithCount,
  body: Record<string, unknown>,
): Promise<{ quantity: number; date: string | null } | Response> => {
  const quantity = resolvePositiveQuantity(body);
  if (quantity instanceof Response) return quantity;
  const clampedQuantity = Math.min(quantity, listing.max_quantity);
  const date = await resolveBookingDate(listing, body);
  return date instanceof Response ? date : { date, quantity: clampedQuantity };
};

/** POST /api/listings/:slug/book — create a booking */
export const handleBook = withActiveListing(
  async (request, listing, server) => {
    // A booking can never start from a non-standalone child: such a
    // child is only bookable through one of its parents, so reject it as a direct
    // API entry. A `bookable_alone` child has its own page/API eligibility, so it
    // books directly here.
    if (await anyNonStandaloneChild([listing.id])) {
      return apiError(
        "This listing must be booked through its parent listing.",
      );
    }

    const limited = await checkBookingRateLimit(request, server);
    if (limited) return limited;

    if (isRegistrationClosed(listing)) {
      return apiError("Registration is closed");
    }

    const body = await parseApiJsonBody(request);
    if (body instanceof Response) return body;

    // Resolve the booking quantity + date once, shared by the parent and standalone
    // paths so neither re-derives it (and the JSON contract reads one way).
    const qtyAndDate = await resolveQuantityAndDate(listing, body);
    if (qtyAndDate instanceof Response) return qtyAndDate;
    const { quantity, date } = qtyAndDate;

    // A parent requires the buyer to choose its children: fold the
    // submitted `children` into a multi-item order rather than booking the parent
    // alone, which would bypass the gate.
    if (await parentRequiresChild(listing.id)) {
      return processParentApiBooking(request, listing, body, quantity, date);
    }

    // Customisable-days listings are priced by a chosen day count, which this
    // endpoint doesn't accept — booking them here would charge the wrong amount,
    // so they must be booked through the website form.
    if (listing.customisable_days) {
      return apiError("This listing must be booked through the website.");
    }

    const form = toFormParams(body);

    // Validate fields using the same form validation as the web
    const paid = isPaidListing(listing);
    const valResult = tryValidateTicketFields(
      form,
      listing.fields,
      (msg) => apiError(msg),
      paid,
    );
    if (valResult instanceof Response) return valResult;
    const values = valResult;

    // Parse custom price for pay-more listings
    const customUnitPrice = resolveCustomPrice(listing, form);
    if (customUnitPrice instanceof Response) return customUnitPrice;

    const contact = extractContact(values);
    return bookingResultToResponse(
      await processBooking(
        listing,
        contact,
        quantity,
        date,
        getBaseUrl(request),
        customUnitPrice,
      ),
    );
  },
);
