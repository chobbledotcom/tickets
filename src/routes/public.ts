/**
 * Public routes - home page and ticket reservation
 */

import { isPaymentsEnabled } from "#lib/config.ts";
import { createAttendee, deleteAttendee, hasAvailableSpots } from "#lib/db";
import { validateForm } from "#lib/forms.tsx";
import { createCheckoutSession } from "#lib/stripe.ts";
import type { Attendee, EventWithCount } from "#lib/types.ts";
import { homePage, ticketFields, ticketPage } from "#templates";
import {
  createIdRoute,
  csrfCookie,
  generateSecureToken,
  getBaseUrl,
  htmlResponse,
  parseCookies,
  type RouteHandler,
  redirect,
  requireCsrfForm,
  withCookie,
  withEvent,
} from "./utils.ts";

/**
 * Handle GET / (home page)
 */
export const handleHome = (): Response => {
  return htmlResponse(homePage());
};

/** Path for ticket CSRF cookies */
const ticketCsrfPath = (eventId: number): string => `/ticket/${eventId}`;

/**
 * Handle GET /ticket/:id
 */
export const handleTicketGet = (eventId: number): Promise<Response> =>
  withEvent(eventId, (event) => {
    const token = generateSecureToken();
    return withCookie(
      htmlResponse(ticketPage(event, token)),
      csrfCookie(token, ticketCsrfPath(eventId)),
    );
  });

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
  quantity: number,
  csrfToken: string,
): Promise<Response> => {
  const baseUrl = getBaseUrl(request);
  const session = await createCheckoutSession(
    event,
    attendee,
    baseUrl,
    quantity,
  );

  if (session?.url) {
    return redirect(session.url);
  }

  // If Stripe session creation failed, clean up and show error
  await deleteAttendee(attendee.id);
  return htmlResponse(
    ticketPage(
      event,
      csrfToken,
      "Failed to create payment session. Please try again.",
    ),
    500,
  );
};

/**
 * Parse and validate quantity from form
 * Returns at least 1, capped at max_quantity (availability checked separately)
 */
const parseQuantity = (
  form: URLSearchParams,
  event: EventWithCount,
): number => {
  const raw = form.get("quantity") || "1";
  const quantity = Number.parseInt(raw, 10);
  if (Number.isNaN(quantity) || quantity < 1) return 1;
  return Math.min(quantity, event.max_quantity);
};

/**
 * Create CSRF error response for ticket page
 */
const ticketCsrfError = (event: EventWithCount) => (newToken: string) =>
  withCookie(
    htmlResponse(
      ticketPage(event, newToken, "Invalid or expired form. Please try again."),
      403,
    ),
    csrfCookie(newToken, ticketCsrfPath(event.id)),
  );

/**
 * Process ticket reservation for an event
 */
const processTicketReservation = async (
  request: Request,
  event: EventWithCount,
): Promise<Response> => {
  // Get current CSRF token from cookie for re-rendering on validation errors
  const cookies = parseCookies(request);
  const currentToken = cookies.get("csrf_token") || generateSecureToken();

  const csrfResult = await requireCsrfForm(request, ticketCsrfError(event));
  if (!csrfResult.ok) return csrfResult.response;

  const { form } = csrfResult;
  const validation = validateForm(form, ticketFields);

  if (!validation.valid) {
    return htmlResponse(ticketPage(event, currentToken, validation.error), 400);
  }

  const quantity = parseQuantity(form, event);
  const available = await hasAvailableSpots(event.id, quantity);
  if (!available) {
    return htmlResponse(
      ticketPage(event, currentToken, "Sorry, not enough spots available"),
      400,
    );
  }

  const { values } = validation;
  const attendee = await createAttendee(
    event.id,
    values.name as string,
    values.email as string,
    null,
    quantity,
  );

  if (await requiresPayment(event)) {
    return handlePaymentFlow(request, event, attendee, quantity, currentToken);
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
