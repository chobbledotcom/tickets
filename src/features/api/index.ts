/**
 * Public JSON API routes
 *
 * Exposes listing listing, details, availability, and booking
 * with the same data and validation as the web UI.
 */

import { filter, pipe } from "#fp";
import { isRegistrationClosed } from "#routes/format.ts";
import { classifyForDiscovery } from "#routes/public/discovery.ts";
import { parseCustomPrice } from "#routes/public/ticket-form.ts";
import {
  anyChildListing,
  constrainParentDailyDates,
  parentRequiresChild,
} from "#routes/public/ticket-payment.ts";
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
import { buildTicketListing } from "#templates/public.tsx";

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
 * the group's combined cap. The sold-out/max-purchasable core is the shared
 * {@link buildTicketListing} (the same availability projection the web cards and
 * the parent-sold-out discovery path use), so the API and the web never compute
 * "is this listing bookable, and how many?" differently. */
export const toPublicListing = (
  listing: ListingWithCount,
  closed: boolean,
  availableDates: string[] | undefined,
  groupRemaining: number | undefined,
): PublicListing => {
  const { isSoldOut, maxPurchasable } = buildTicketListing(
    listing,
    closed,
    groupRemaining,
  );

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
// Parent/child discovery guard (Fix 2)
// =============================================================================

/** How a single listing should read on the detail/availability surfaces under
 * the parent/child feature: a child is not standalone-bookable (404, matching
 * how the web booking page rejects a child slug), and a parent with no bookable
 * child reads sold out / unavailable (invariant I6). */
type ListingDiscoveryState = { isChild: boolean; isSoldOutParent: boolean };

/** Classify one listing for the detail/availability endpoints, reusing the same
 * discovery classification the web surfaces use (child suppression + parent
 * sold-out). Flag-off (or a plain listing) yields the neutral state, so existing
 * endpoints are unchanged until parents ship. */
const listingDiscoveryState = async (
  listing: ListingWithCount,
): Promise<ListingDiscoveryState> => {
  const { childIds, soldOutParentIds } = await classifyForDiscovery([listing]);
  return {
    isChild: childIds.has(listing.id),
    isSoldOutParent: soldOutParentIds.has(listing.id),
  };
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
  // A child is never standalone-bookable (invariant I3), so omit children from
  // the discovery list — a client must not find one here and then hit the
  // booking 400 (Fix 2, parents.md "Discovery responses"). A parent with no
  // bookable child is sold out (invariant I6): its OWN row capacity ignores its
  // children, so the list must project it to sold-out / not-bookable to stay
  // consistent with the detail/availability endpoints (Fix 3) — otherwise a
  // client lists it as bookable then hits the parent-sold-out outcome at detail.
  const { childIds, soldOutParentIds } =
    await classifyForDiscovery(visibleListings);
  const bookableListings = visibleListings.filter((e) => !childIds.has(e.id));
  const groupRemaining = await getGroupRemainingByListingId(bookableListings);
  const listings = bookableListings.map((e) => {
    const publicListing = toPublicListing(
      e,
      isRegistrationClosed(e),
      undefined,
      groupRemaining.get(e.id),
    );
    return soldOutParentIds.has(e.id)
      ? { ...publicListing, isSoldOut: true, maxPurchasable: 0 }
      : publicListing;
  });
  return apiResponse({ listings });
};

/** GET /api/listings/:slug — single listing detail */
const handleGetListing = withActiveListing(async (_request, listing) => {
  const { isChild, isSoldOutParent } = await listingDiscoveryState(listing);
  // A child is not standalone-bookable (invariant I3), so its detail endpoint is
  // a 404 — the same not-bookable outcome the web booking page gives a child
  // slug (Fix 2).
  if (isChild) return apiResponse(LISTING_NOT_FOUND, 404);
  const closed = isRegistrationClosed(listing);
  let availableDates: string[] | undefined;
  if (listing.listing_type === "daily") {
    const holidays = await getActiveHolidays();
    // A daily parent's API dates must match what the web selector offers: a date
    // no required child can serve (for the inherited span) is removed from the
    // parent's own calendar, so the API never advertises a date the fold rejects
    // (Fix 4). For a non-parent daily listing this is a no-op.
    availableDates = await constrainParentDailyDates(
      listing,
      getAvailableDates(listing, holidays),
      holidays,
    );
  }
  const publicListing = toPublicListing(
    listing,
    closed,
    availableDates,
    await getGroupRemainingForListing(listing),
  );
  // A parent with no bookable child is sold out (invariant I6); the route
  // listing's own capacity ignores its children, so project the discovery
  // sold-out outcome onto the response rather than advertising it as bookable.
  return apiResponse({
    listing: isSoldOutParent
      ? { ...publicListing, isSoldOut: true, maxPurchasable: 0 }
      : publicListing,
  });
});

/** GET /api/listings/:slug/availability — check if spots are available */
const handleCheckAvailability = withActiveListing(async (request, listing) => {
  const { isChild, isSoldOutParent } = await listingDiscoveryState(listing);
  // A child is not standalone-bookable (invariant I3) — 404, consistent with the
  // detail endpoint and the web booking page (Fix 2).
  if (isChild) return apiResponse(LISTING_NOT_FOUND, 404);
  // A parent with no bookable child is sold out (invariant I6): its own capacity
  // ignores its children, so report it unavailable rather than letting the
  // route listing's standalone spots advertise it as bookable.
  if (isSoldOutParent) return apiResponse({ available: false });
  const url = new URL(request.url);
  const quantity =
    parseNonNegativeInt(url.searchParams.get("quantity") ?? "1") ?? 1;
  const date = url.searchParams.get("date") || undefined;
  // A daily parent's availability must honour the child-date union (Fix 1): the
  // route listing's own capacity ignores its children, so it could answer
  // `available: true` for a date the (child-constrained) detail endpoint omits
  // and the booking fold then rejects. Constrain the requested date through the
  // same `constrainParentDailyDates` union the detail endpoint uses; a date no
  // required child can serve for the inherited span is unavailable. For a
  // non-parent daily listing (no child edges) this is a no-op.
  if (listing.listing_type === "daily" && date) {
    const holidays = await getActiveHolidays();
    const childServableDates = await constrainParentDailyDates(
      listing,
      getAvailableDates(listing, holidays),
      holidays,
    );
    if (!childServableDates.includes(date)) {
      return apiResponse({ available: false });
    }
  }
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
  // A booking can never start from a child (invariant I3): a child is only
  // bookable through one of its parents, so reject it as a direct API entry.
  if (await anyChildListing([listing.id])) {
    return apiResponse(
      { error: "This listing must be booked through its parent listing." },
      400,
    );
  }
  // A parent requires the buyer to choose one of its children (invariant I1).
  // The web booking page enforces that with a per-parent selector, but this
  // endpoint has no child-selection input, so booking the parent here would
  // create it without its required child — bypassing the gate. Reject and direct
  // the caller to the web booking page (Fix 1, parents.md "Public/JSON API
  // booking").
  if (await parentRequiresChild(listing.id)) {
    return apiResponse(
      {
        error:
          "This listing must be booked through the website, which requires choosing a child option.",
      },
      400,
    );
  }

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

  // Parse quantity
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
