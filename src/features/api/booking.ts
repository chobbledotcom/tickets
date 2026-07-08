import { apiResponse } from "#routes/api/cors.ts";
import { processParentApiBooking } from "#routes/api/folded-booking.ts";
import {
  checkBookingRateLimit,
  parseApiJsonBody,
  resolveCustomPrice,
  resolvePositiveQuantity,
  toFormParams,
  withActiveListing,
} from "#routes/api/helpers.ts";
import { isRegistrationClosed } from "#routes/format.ts";
import { parentRequiresChild } from "#routes/public/ticket-payment.ts";
import { getBaseUrl } from "#routes/url.ts";
import { processBooking } from "#shared/booking.ts";
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
      return apiResponse({
        booking: {
          // Outstanding balance in minor units; 0 when fully paid, positive when
          // the booking was taken without collecting payment (no provider), so
          // the integration knows the amount left to collect from the buyer.
          amountOwed: result.attendee.remaining_balance,
          ticketToken: result.attendee.ticket_token,
          ticketUrl: `/t/${result.attendee.ticket_token}`,
        },
      });
    case "checkout":
      return apiResponse({ booking: { checkoutUrl: result.checkoutUrl } });
    case "sold_out":
      return apiResponse({ error: "Sorry, not enough spots available" }, 409);
    case "checkout_failed":
      return result.error
        ? apiResponse({ error: result.error }, 400)
        : apiResponse({ error: "Failed to create payment session" }, 500);
    case "creation_failed":
      return result.reason === "capacity_exceeded"
        ? apiResponse({ error: "Sorry, not enough spots available" }, 409)
        : apiResponse({ error: "Registration failed. Please try again." }, 500);
  }
};

/**
 * Resolve and validate the booking date for daily listings (a no-op for other
 * listing types). Returns the submitted date, null for non-daily listings, or a
 * 400 response when the date is missing or unavailable.
 */
const resolveBookingDate = async (
  listing: ListingWithCount,
  body: Record<string, unknown>,
): Promise<string | null | Response> => {
  if (listing.listing_type !== "daily") return null;
  const submittedDate = String(body.date ?? "");
  const availableDates = getAvailableDates(listing, await getActiveHolidays());
  if (!submittedDate || !availableDates.includes(submittedDate)) {
    return apiResponse({ error: "Please select a valid date" }, 400);
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
      return apiResponse(
        { error: "This listing must be booked through its parent listing." },
        400,
      );
    }

    const limited = await checkBookingRateLimit(request, server);
    if (limited) return limited;

    if (isRegistrationClosed(listing)) {
      return apiResponse({ error: "Registration is closed" }, 400);
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
      return apiResponse(
        { error: "This listing must be booked through the website." },
        400,
      );
    }

    const form = toFormParams(body);

    // Validate fields using the same form validation as the web
    const paid = isPaidListing(listing);
    const valResult = tryValidateTicketFields(
      form,
      listing.fields,
      (msg) => apiResponse({ error: msg }, 400),
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
