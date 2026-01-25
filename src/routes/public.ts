/**
 * Public routes - home page and ticket reservation
 */

import { isPaymentsEnabled } from "#lib/config.ts";
import { createAttendeeAtomic, hasAvailableSpots } from "#lib/db/attendees.ts";
import { validateForm } from "#lib/forms.tsx";
import {
  createCheckoutSessionWithIntent,
  type RegistrationIntent,
} from "#lib/stripe.ts";
import type { EventWithCount } from "#lib/types.ts";
import { logAndNotifyRegistration } from "#lib/webhook.ts";
import {
  createRouter,
  defineRoutes,
  type RouteParams,
} from "#routes/router.ts";
import {
  csrfCookie,
  generateSecureToken,
  getBaseUrl,
  htmlResponse,
  htmlResponseWithCookie,
  parseCookies,
  redirect,
  requireCsrfForm,
  withActiveEventBySlug,
} from "#routes/utils.ts";
import { ticketFields } from "#templates/fields.ts";
import { homePage, ticketPage } from "#templates/public.tsx";

/**
 * Handle GET / (home page)
 */
export const handleHome = (): Response => {
  return htmlResponse(homePage());
};

/** Path for ticket CSRF cookies */
const ticketCsrfPath = (slug: string): string => `/ticket/${slug}`;

/** Ticket response with CSRF cookie - curried to thread event and token through */
const ticketResponseWithCookie =
  (event: EventWithCount) =>
  (token: string) =>
  (error?: string, status = 200) =>
    htmlResponseWithCookie(csrfCookie(token, ticketCsrfPath(event.slug)))(
      ticketPage(event, token, error),
      status,
    );

/** Ticket response without cookie - for validation errors after CSRF passed */
const ticketResponse =
  (event: EventWithCount, token: string) =>
  (error: string, status = 400) =>
    htmlResponse(ticketPage(event, token, error), status);

/**
 * Handle GET /ticket/:slug
 */
export const handleTicketGet = (slug: string): Promise<Response> =>
  withActiveEventBySlug(slug, (event) => {
    const token = generateSecureToken();
    return ticketResponseWithCookie(event)(token)();
  });

/**
 * Check if payment is required for an event
 */
const requiresPayment = async (
  event: { unit_price: number | null },
): Promise<boolean> => {
  return (
    (await isPaymentsEnabled()) &&
    event.unit_price !== null &&
    event.unit_price > 0
  );
};

/** Common parameters for reservation processing */
type ReservationParams = {
  event: EventWithCount;
  name: string;
  email: string;
  quantity: number;
  token: string;
};

/**
 * Handle payment flow for ticket purchase.
 * Creates Stripe session with registration intent - no attendee yet.
 * Attendee is created atomically after payment confirmation.
 */
const handlePaymentFlow = async (
  request: Request,
  event: EventWithCount,
  intent: RegistrationIntent,
  csrfToken: string,
): Promise<Response> => {
  const baseUrl = getBaseUrl(request);
  const session = await createCheckoutSessionWithIntent(event, intent, baseUrl);

  if (session?.url) {
    return redirect(session.url);
  }

  return ticketResponse(event, csrfToken)(
    "Failed to create payment session. Please try again.",
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

/** CSRF error response for ticket page */
const ticketCsrfError = (event: EventWithCount) => (token: string) =>
  ticketResponseWithCookie(event)(token)(
    "Invalid or expired form. Please try again.",
    403,
  );

/** Handle paid event registration - check availability, create Stripe session */
const processPaidReservation = async (
  request: Request,
  params: ReservationParams,
): Promise<Response> => {
  const { event, name, email, quantity, token } = params;
  const available = await hasAvailableSpots(event.id, quantity);
  if (!available) {
    return ticketResponse(event, token)("Sorry, not enough spots available");
  }

  const intent: RegistrationIntent = {
    eventId: event.id,
    name,
    email,
    quantity,
  };
  return handlePaymentFlow(request, event, intent, token);
};

/** Handle free event registration - atomic create with capacity check */
const processFreeReservation = async (
  reservation: ReservationParams,
): Promise<Response> => {
  const { event, name, email, quantity, token } = reservation;
  const result = await createAttendeeAtomic(
    event.id,
    name,
    email,
    null,
    quantity,
  );

  if (!result.success) {
    const message =
      result.reason === "capacity_exceeded"
        ? "Sorry, not enough spots available"
        : "Registration failed. Please try again.";
    return ticketResponse(event, token)(message);
  }

  await logAndNotifyRegistration(event, result.attendee);
  return redirect(event.thank_you_url);
};

/**
 * Process ticket reservation for an event.
 * - For paid events: creates Stripe session with intent, attendee created after payment
 * - For free events: atomically creates attendee with capacity check
 */
const processTicketReservation = async (
  request: Request,
  event: EventWithCount,
): Promise<Response> => {
  const cookies = parseCookies(request);
  const currentToken = cookies.get("csrf_token") || generateSecureToken();

  const csrfResult = await requireCsrfForm(request, ticketCsrfError(event));
  if (!csrfResult.ok) return csrfResult.response;

  const { form } = csrfResult;
  const validation = validateForm(form, ticketFields);
  if (!validation.valid) {
    return ticketResponse(event, currentToken)(validation.error);
  }

  const quantity = parseQuantity(form, event);
  const name = validation.values.name as string;
  const email = validation.values.email as string;
  const params: ReservationParams = {
    event,
    name,
    email,
    quantity,
    token: currentToken,
  };

  if (await requiresPayment(event)) {
    return processPaidReservation(request, params);
  }
  return processFreeReservation(params);
};

/**
 * Handle POST /ticket/:slug (reserve ticket)
 */
export const handleTicketPost = (
  request: Request,
  slug: string,
): Promise<Response> =>
  withActiveEventBySlug(slug, (event) =>
    processTicketReservation(request, event),
  );

/** Parse ticket slug from params */
const parseTicketSlug = (params: RouteParams): string => params.slug ?? "";

/** Ticket routes definition */
const ticketRoutes = defineRoutes({
  "GET /ticket/:slug": (_, params) => handleTicketGet(parseTicketSlug(params)),
  "POST /ticket/:slug": (request, params) =>
    handleTicketPost(request, parseTicketSlug(params)),
});

/** Route ticket requests */
export const routeTicket = createRouter(ticketRoutes);
