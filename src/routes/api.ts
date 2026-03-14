/**
 * Public JSON API routes
 *
 * Exposes event listing, details, availability, and booking
 * with the same data and validation as the web UI.
 */

import { filter, map, pipe } from "#fp";
import { processBooking } from "#lib/booking.ts";
import { getAvailableDates } from "#lib/dates.ts";
import { hasAvailableSpots } from "#lib/db/attendees.ts";
import { getAllEvents, getEventWithCountBySlug } from "#lib/db/events.ts";
import { getActiveHolidays } from "#lib/db/holidays.ts";
import type { EventWithCount } from "#lib/types.ts";
import { sortEvents } from "#lib/sort-events.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import {
  getBaseUrl,
  isRegistrationClosed,
  jsonResponse,
} from "#routes/utils.ts";
import { extractContact, tryValidateTicketFields } from "#templates/fields.ts";
import { validatePrice } from "#lib/currency.ts";

// =============================================================================
// CORS
// =============================================================================

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
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
  new Response(null, { status: 204, headers: CORS_HEADERS });

// =============================================================================
// Public event shape
// =============================================================================

export type PublicEvent = {
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
  fields: string;
  eventType: string;
  isSoldOut: boolean;
  isClosed: boolean;
  maxPurchasable: number;
  availableDates?: string[];
};

/** Serialize an event to the public API shape (same data the web UI renders) */
export const toPublicEvent = (event: EventWithCount, closed = false, availableDates?: string[]): PublicEvent => {
  const spotsRemaining = event.max_attendees - event.attendee_count;
  const isSoldOut = spotsRemaining <= 0;
  const maxPurchasable = isSoldOut || closed
    ? 0
    : Math.min(event.max_quantity, spotsRemaining);

  const result: PublicEvent = {
    name: event.name,
    slug: event.slug,
    description: event.description,
    date: event.date || null,
    location: event.location || null,
    imageUrl: event.image_url || null,
    unitPrice: event.unit_price,
    canPayMore: event.can_pay_more,
    maxPrice: event.max_price,
    nonTransferable: event.non_transferable,
    fields: event.fields,
    eventType: event.event_type,
    isSoldOut,
    isClosed: closed,
    maxPurchasable,
  };

  if (availableDates) {
    result.availableDates = availableDates;
  }

  return result;
};

// =============================================================================
// Helpers
// =============================================================================

const EVENT_NOT_FOUND = { error: "Event not found" } as const;

/** Look up an active event by slug, returning a 404 response if missing/inactive */
const findActiveEvent = async (
  slug: string,
): Promise<EventWithCount | Response> => {
  const event = await getEventWithCountBySlug(slug);
  return event && event.active ? event : apiResponse(EVENT_NOT_FOUND, 404);
};

/** Parse a JSON request body, returning a 400 response on failure */
const parseJsonBody = async (
  request: Request,
): Promise<Record<string, unknown> | Response> => {
  try {
    return await request.json();
  } catch {
    return apiResponse({ error: "Invalid JSON body" }, 400);
  }
};

/** Wrap a handler that needs an active event — handles slug lookup + 404 */
const withActiveEvent = (
  handler: (request: Request, event: EventWithCount) => Promise<Response>,
) =>
  async (request: Request, { slug }: { slug: string }): Promise<Response> => {
    const result = await findActiveEvent(slug);
    return result instanceof Response ? result : handler(request, result);
  };

// =============================================================================
// Handlers
// =============================================================================

/** GET /api/events — list active, non-hidden events */
const handleListEvents = async (): Promise<Response> => {
  const allEvents = await getAllEvents();
  const holidays = await getActiveHolidays();
  const events = pipe(
    filter((e: EventWithCount) => e.active && !e.hidden),
    (active: EventWithCount[]) => sortEvents(active, holidays),
    map((e: EventWithCount) => toPublicEvent(e, isRegistrationClosed(e))),
  )(allEvents);
  return apiResponse({ events });
};

/** GET /api/events/:slug — single event detail */
const handleGetEvent = withActiveEvent(async (_request, event) => {
  const closed = isRegistrationClosed(event);
  let availableDates: string[] | undefined;
  if (event.event_type === "daily") {
    availableDates = getAvailableDates(event, await getActiveHolidays());
  }
  return apiResponse({ event: toPublicEvent(event, closed, availableDates) });
});

/** GET /api/events/:slug/availability — check if spots are available */
const handleCheckAvailability = withActiveEvent(async (request, event) => {
  const url = new URL(request.url);
  const quantity = Math.max(1, Number.parseInt(url.searchParams.get("quantity") || "1", 10) || 1);
  const date = url.searchParams.get("date") || undefined;
  return apiResponse({ available: await hasAvailableSpots(event.id, quantity, date) });
});

/** Convert JSON body fields to URLSearchParams for validation compatibility */
const toFormParams = (body: Record<string, unknown>): URLSearchParams =>
  Object.entries(body).reduce((params, [key, value]) => {
    if (value !== null && value !== undefined) params.set(key, String(value));
    return params;
  }, new URLSearchParams());

/** Parse and validate a custom unit price from API input */
const parseCustomPrice = (
  priceRaw: unknown,
  minPrice: number,
  maxPrice: number,
) => validatePrice(
  priceRaw === undefined || priceRaw === null ? "" : String(priceRaw),
  minPrice,
  maxPrice,
);

/** Map a BookingResult to an API JSON response */
const bookingResultToResponse = (result: import("#lib/booking.ts").BookingResult): Response => {
  switch (result.type) {
    case "success":
      return apiResponse({
        ticketToken: result.attendee.ticket_token,
        ticketUrl: `/t/${result.attendee.ticket_token}`,
      });
    case "checkout":
      return apiResponse({ checkoutUrl: result.checkoutUrl });
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

/** POST /api/events/:slug/book — create a booking */
const handleBook = withActiveEvent(async (request, event) => {
  if (isRegistrationClosed(event)) {
    return apiResponse({ error: "Registration is closed" }, 400);
  }

  const bodyOrError = await parseJsonBody(request);
  if (bodyOrError instanceof Response) return bodyOrError;
  const body = bodyOrError;

  // Validate fields using the same form validation as the web
  const valResult = tryValidateTicketFields(
    toFormParams(body), event.fields,
    (msg) => apiResponse({ error: msg }, 400),
  );
  if (valResult instanceof Response) return valResult;
  const values = valResult;

  // Parse quantity
  const rawQuantity = Number.parseInt(String(body.quantity ?? "1"), 10);
  const quantity = Number.isNaN(rawQuantity) || rawQuantity < 1
    ? 1
    : Math.min(rawQuantity, event.max_quantity);

  // Validate date for daily events
  let date: string | null = null;
  if (event.event_type === "daily") {
    const submittedDate = String(body.date ?? "");
    const holidays = await getActiveHolidays();
    const availableDates = getAvailableDates(event, holidays);
    if (!submittedDate || !availableDates.includes(submittedDate)) {
      return apiResponse({ error: "Please select a valid date" }, 400);
    }
    date = submittedDate;
  }

  // Parse custom price for pay-more events
  let customUnitPrice: number | undefined;
  if (event.can_pay_more) {
    const priceResult = parseCustomPrice(body.customPrice, event.unit_price, event.max_price);
    if (!priceResult.ok) {
      return apiResponse({ error: priceResult.error }, 400);
    }
    customUnitPrice = priceResult.price;
  }

  const contact = extractContact(values);
  return bookingResultToResponse(
    await processBooking(event, contact, quantity, date, getBaseUrl(request), customUnitPrice),
  );
});

// =============================================================================
// Route definitions
// =============================================================================

const apiRoutes = defineRoutes({
  "GET /api/events": handleListEvents,
  "GET /api/events/:slug": handleGetEvent,
  "GET /api/events/:slug/availability": handleCheckAvailability,
  "POST /api/events/:slug/book": handleBook,
  "OPTIONS /api/events": handleOptions,
  "OPTIONS /api/events/:slug": handleOptions,
  "OPTIONS /api/events/:slug/availability": handleOptions,
  "OPTIONS /api/events/:slug/book": handleOptions,
});

export const routeApi = createRouter(apiRoutes);
