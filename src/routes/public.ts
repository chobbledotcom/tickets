/**
 * Public routes - home page and ticket reservation
 */

import { isPaymentsEnabled } from "#lib/config.ts";
import { createAttendee, deleteAttendee, hasAvailableSpots } from "#lib/db.ts";
import { validateForm } from "#lib/forms.tsx";
import { createCheckoutSession } from "#lib/stripe.ts";
import type { Attendee, EventWithCount } from "#lib/types.ts";
import { homePage, ticketFields, ticketPage } from "#templates";
import {
  createIdRoute,
  getBaseUrl,
  htmlResponse,
  parseFormData,
  type RouteHandler,
  redirect,
  withEvent,
} from "./utils.ts";

/**
 * Handle GET / (home page)
 */
export const handleHome = (): Response => {
  return htmlResponse(homePage());
};

/**
 * Handle GET /ticket/:id
 */
export const handleTicketGet = (eventId: number): Promise<Response> =>
  withEvent(eventId, (event) => htmlResponse(ticketPage(event)));

/**
 * Check if payment is required for an event
 */
const requiresPayment = async (event: {
  unit_price: number | null;
}): Promise<boolean> => {
  return (
    (await isPaymentsEnabled()) &&
    event.unit_price !== null &&
    event.unit_price > 0
  );
};

/**
 * Handle payment flow for ticket purchase
 */
const handlePaymentFlow = async (
  request: Request,
  event: EventWithCount,
  attendee: Attendee,
): Promise<Response> => {
  const baseUrl = getBaseUrl(request);
  const session = await createCheckoutSession(event, attendee, baseUrl);

  if (session?.url) {
    return redirect(session.url);
  }

  // If Stripe session creation failed, clean up and show error
  await deleteAttendee(attendee.id);
  return htmlResponse(
    ticketPage(event, "Failed to create payment session. Please try again."),
    500,
  );
};

/**
 * Process ticket reservation for an event
 */
const processTicketReservation = async (
  request: Request,
  event: EventWithCount,
): Promise<Response> => {
  const form = await parseFormData(request);
  const validation = validateForm(form, ticketFields);

  if (!validation.valid) {
    return htmlResponse(ticketPage(event, validation.error), 400);
  }

  const available = await hasAvailableSpots(event.id);
  if (!available) {
    return htmlResponse(
      ticketPage(event, "Sorry, this event is now full"),
      400,
    );
  }

  const { values } = validation;
  const attendee = await createAttendee(
    event.id,
    values.name as string,
    values.email as string,
  );

  if (await requiresPayment(event)) {
    return handlePaymentFlow(request, event, attendee);
  }

  return redirect(event.thank_you_url);
};

/**
 * Handle POST /ticket/:id (reserve ticket)
 */
export const handleTicketPost = (
  request: Request,
  eventId: number,
): Promise<Response> =>
  withEvent(eventId, (event) => processTicketReservation(request, event));

/** Route ticket requests */
export const routeTicket: RouteHandler = createIdRoute(
  /^\/ticket\/(\d+)$/,
  (request) => ({
    GET: handleTicketGet,
    POST: (id) => handleTicketPost(request, id),
  }),
);
