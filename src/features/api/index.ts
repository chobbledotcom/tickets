/**
 * Public JSON API routes
 *
 * Exposes listing listing, details, availability, and booking
 * with the same data and validation as the web UI.
 */

import { filter, pipe } from "#fp";
import { isRegistrationClosed } from "#routes/format.ts";
import { parseCustomPrice } from "#routes/public/ticket-form.ts";
import { jsonResponse } from "#routes/response.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import type { ServerContext } from "#routes/types.ts";
import { getBaseUrl, getClientIp } from "#routes/url.ts";
import { processBooking } from "#shared/booking.ts";
import { getAvailableDates } from "#shared/dates.ts";
import {
  getGroupRemainingByListingId,
  getGroupRemainingForListing,
} from "#shared/db/attendees/capacity.ts";
import { hasAvailableSpots } from "#shared/db/attendees.ts";
import {
  isBookingRateLimited,
  recordBookingAttempt,
} from "#shared/db/booking-attempts.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import {
  getAllListings,
  getListingWithCountBySlug,
} from "#shared/db/listings.ts";
import { FormParams } from "#shared/form-data.ts";
import { sortListings } from "#shared/sort-listings.ts";
import {
  availableDayCounts,
  dayPriceFor,
  isPaidListing,
  type ListingWithCount,
} from "#shared/types.ts";
import {
  parseNonNegativeInt,
  parsePositiveInt,
} from "#shared/validation/number.ts";
import { extractContact, tryValidateTicketFields } from "#templates/fields.ts";

// =============================================================================
// CORS
// =============================================================================

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-origin": "*",
  "access-control-max-age": "86400",
};

/** JSON response with CORS headers */
const apiResponse = (data: unknown, status = 200): Response => {
  const response = jsonResponse(data, status);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
};

/** CORS preflight response */
const handleOptions = (): Response =>
  new Response(null, { headers: CORS_HEADERS, status: 204 });

// =============================================================================
// Public listing shape
// =============================================================================

export type PublicListing = {
  name: string;
  slug: string;
  description: string;
  date: string | null;
  location: string | null;
  imageUrl: string | null;
  unitPrice: number;
  canPayMore: boolean;
  maxPrice: number;
  nonTransferable: boolean;
  purchaseOnly: boolean;
  fields: string;
  listingType: string;
  /** True when visitors choose how many days to book; price comes from
   * `dayPrices` rather than `unitPrice`. */
  customisableDays: boolean;
  /** Offered day counts mapped to their price (minor units). Present only for
   * customisable-days listings. */
  dayPrices?: Record<number, number>;
  isSoldOut: boolean;
  isClosed: boolean;
  maxPurchasable: number;
  availableDates?: string[];
};

/** `groupRemaining`, when defined, clamps the displayed sold-out state to
 * the group's combined cap. */
export const toPublicListing = (
  listing: ListingWithCount,
  closed: boolean,
  availableDates: string[] | undefined,
  groupRemaining: number | undefined,
): PublicListing => {
  const listingRemaining = listing.max_attendees - listing.attendee_count;
  const spotsRemaining =
    groupRemaining === undefined
      ? listingRemaining
      : Math.min(listingRemaining, groupRemaining);
  const isSoldOut = spotsRemaining <= 0;
  const maxPurchasable =
    isSoldOut || closed ? 0 : Math.min(listing.max_quantity, spotsRemaining);

  const result: PublicListing = {
    canPayMore: listing.can_pay_more,
    customisableDays: listing.customisable_days,
    date: listing.date || null,
    description: listing.description,
    fields: listing.fields,
    imageUrl: listing.image_url || null,
    isClosed: closed,
    isSoldOut,
    listingType: listing.listing_type,
    location: listing.location || null,
    maxPrice: listing.max_price,
    maxPurchasable,
    name: listing.name,
    nonTransferable: listing.non_transferable,
    purchaseOnly: listing.purchase_only,
    slug: listing.slug,
    unitPrice: listing.unit_price,
  };

  if (availableDates) {
    result.availableDates = availableDates;
  }

  if (listing.customisable_days) {
    // availableDayCounts only yields priced counts, so dayPriceFor is non-null.
    result.dayPrices = Object.fromEntries(
      availableDayCounts(listing).map((n) => [n, dayPriceFor(listing, n)!]),
    );
  }

  return result;
};

// =============================================================================
// Helpers
// =============================================================================

const LISTING_NOT_FOUND = { error: "Listing not found" } as const;

/** Look up an active listing by slug, returning a 404 response if missing/inactive */
const findActiveListing = async (
  slug: string,
): Promise<ListingWithCount | Response> => {
  const listing = await getListingWithCountBySlug(slug);
  return listing?.active ? listing : apiResponse(LISTING_NOT_FOUND, 404);
};

/** Parse a JSON request body, returning a 400 API response on failure */
const parseApiJsonBody = async (
  request: Request,
): Promise<Record<string, unknown> | Response> => {
  try {
    return await request.json();
  } catch {
    return apiResponse({ error: "Invalid JSON body" }, 400);
  }
};

/** Wrap a handler that needs an active listing — handles slug lookup + 404 */
const withActiveListing =
  (
    handler: (
      request: Request,
      listing: ListingWithCount,
      server?: ServerContext,
    ) => Promise<Response>,
  ) =>
  async (
    request: Request,
    { slug }: { slug: string },
    server?: ServerContext,
  ): Promise<Response> => {
    const result = await findActiveListing(slug);
    return result instanceof Response
      ? result
      : handler(request, result, server);
  };

// =============================================================================
// Handlers
// =============================================================================

/** GET /api/listings — list active, non-hidden listings */
const handleListListings = async (): Promise<Response> => {
  const allListings = await getAllListings();
  const holidays = await getActiveHolidays();
  const visibleListings = pipe(
    filter((e: ListingWithCount) => e.active && !e.hidden),
    (active: ListingWithCount[]) => sortListings(active, holidays),
  )(allListings);
  const groupRemaining = await getGroupRemainingByListingId(visibleListings);
  const listings = visibleListings.map((e) =>
    toPublicListing(
      e,
      isRegistrationClosed(e),
      undefined,
      groupRemaining.get(e.id),
    ),
  );
  return apiResponse({ listings });
};

/** GET /api/listings/:slug — single listing detail */
const handleGetListing = withActiveListing(async (_request, listing) => {
  const closed = isRegistrationClosed(listing);
  let availableDates: string[] | undefined;
  if (listing.listing_type === "daily") {
    availableDates = getAvailableDates(listing, await getActiveHolidays());
  }
  return apiResponse({
    listing: toPublicListing(
      listing,
      closed,
      availableDates,
      await getGroupRemainingForListing(listing),
    ),
  });
});

/** GET /api/listings/:slug/availability — check if spots are available */
const handleCheckAvailability = withActiveListing(async (request, listing) => {
  const url = new URL(request.url);
  const quantity =
    parseNonNegativeInt(url.searchParams.get("quantity") ?? "1") ?? 1;
  const date = url.searchParams.get("date") || undefined;
  return apiResponse({
    available: await hasAvailableSpots(
      listing.id,
      quantity,
      date,
      listing.duration_days,
    ),
  });
});

/** Convert JSON body fields to FormParams for validation compatibility */
const toFormParams = (body: Record<string, unknown>): FormParams =>
  Object.entries(body).reduce((params, [key, value]) => {
    if (value !== null && value !== undefined) params.set(key, String(value));
    return params;
  }, new FormParams());

/** Map a BookingResult to an API JSON response */
const bookingResultToResponse = (
  result: import("#shared/booking.ts").BookingResult,
): Response => {
  switch (result.type) {
    case "success":
      return apiResponse({
        booking: {
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
 * Throttle a booking request by client IP. This endpoint is unauthenticated and
 * creates rows, sends emails, and fires webhooks, so a flood could grief
 * capacity and spam the owner. Returns a 429 response when over the limit, or
 * null to proceed (counting this attempt).
 */
const checkBookingRateLimit = async (
  request: Request,
  server?: ServerContext,
): Promise<Response | null> => {
  const ip = getClientIp(request, server);
  if (await isBookingRateLimited(ip)) {
    return apiResponse(
      { error: "Too many booking attempts. Please try again later." },
      429,
    );
  }
  await recordBookingAttempt(ip);
  return null;
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

/** POST /api/listings/:slug/book — create a booking */
const handleBook = withActiveListing(async (request, listing, server) => {
  const limited = await checkBookingRateLimit(request, server);
  if (limited) return limited;

  if (isRegistrationClosed(listing)) {
    return apiResponse({ error: "Registration is closed" }, 400);
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

  const bodyOrError = await parseApiJsonBody(request);
  if (bodyOrError instanceof Response) return bodyOrError;
  const body = bodyOrError;
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

  // Parse quantity. A submitted quantity of exactly 0 must NOT become a
  // one-ticket booking — a quantity-0 line is the admin-only no-quantity sentinel
  // and is never created through the public API. Malformed/absent values keep the
  // lenient default of 1 (existing behaviour).
  if (parseNonNegativeInt(String(body.quantity ?? "1")) === 0) {
    return apiResponse({ error: "Quantity must be at least 1" }, 400);
  }
  const rawQuantity = parsePositiveInt(String(body.quantity ?? "1"));
  const quantity = Math.min(rawQuantity ?? 1, listing.max_quantity);

  // Validate date for daily listings
  const dateResult = await resolveBookingDate(listing, body);
  if (dateResult instanceof Response) return dateResult;
  const date = dateResult;

  // Parse custom price for pay-more listings
  let customUnitPrice: number | undefined;
  if (listing.can_pay_more) {
    const priceResult = parseCustomPrice(
      form,
      "customPrice",
      listing.unit_price,
      listing.max_price,
    );
    if (!priceResult.ok) {
      return apiResponse({ error: priceResult.error }, 400);
    }
    customUnitPrice = priceResult.price;
  }

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
});

// =============================================================================
// Route definitions
// =============================================================================

export const apiRoutes = defineRoutes({
  "GET /api/listings": handleListListings,
  "GET /api/listings/:slug": handleGetListing,
  "GET /api/listings/:slug/availability": handleCheckAvailability,
  "OPTIONS /api/listings": handleOptions,
  "OPTIONS /api/listings/:slug": handleOptions,
  "OPTIONS /api/listings/:slug/availability": handleOptions,
  "OPTIONS /api/listings/:slug/book": handleOptions,
  "POST /api/listings/:slug/book": handleBook,
});

export const routeApi = createRouter(apiRoutes);
