/**
 * Public routes - ticket reservation
 */

import { compact, filter, map, pipe, reduce } from "#fp";
import { getCurrencyCode, isPaymentsEnabled } from "#lib/config.ts";
import { createAttendeeAtomic, hasAvailableSpots } from "#lib/db/attendees.ts";
import { getEventsBySlugsBatch } from "#lib/db/events.ts";
import { validateForm } from "#lib/forms.tsx";
import {
  getActivePaymentProvider,
  type MultiRegistrationIntent,
  type MultiRegistrationItem,
  type RegistrationIntent,
} from "#lib/payments.ts";
import type { EventFields, EventWithCount } from "#lib/types.ts";
import { logDebug } from "#lib/logger.ts";
import { logAndNotifyMultiRegistration, logAndNotifyRegistration } from "#lib/webhook.ts";
import {
  csrfCookie,
  formatCreationError,
  generateSecureToken,
  getBaseUrl,
  htmlResponse,
  htmlResponseWithCookie,
  isRegistrationClosed,
  notFoundResponse,
  parseCookies,
  redirect,
  requireCsrfForm,
  withActiveEventBySlug,
} from "#routes/utils.ts";
import { getTicketFields, mergeEventFields } from "#templates/fields.ts";
import { reservationSuccessPage } from "#templates/payment.tsx";
import {
  buildMultiTicketEvent,
  type MultiTicketEvent,
  multiTicketPage,
  ticketPage,
} from "#templates/public.tsx";

/**
 * Handle GET / (home page) - redirect to admin
 */
export const handleHome = (): Response => redirect("/admin/");

/** Create curried response builder with CSRF cookie */
const makeCsrfResponseBuilder =
  <P extends unknown[]>(
    getPath: (...params: P) => string,
    getContent: (token: string, error: string | undefined, ...params: P) => string,
  ) =>
  (...params: P) =>
  (token: string) =>
  (error?: string, status = 200) =>
    htmlResponseWithCookie(csrfCookie(token, getPath(...params)))(
      getContent(token, error, ...params),
      status,
    );

/** Path for ticket CSRF cookies */
const ticketCsrfPath = (slug: string): string => `/ticket/${slug}`;

/** Ticket response with CSRF cookie */
const ticketResponseWithCookie = makeCsrfResponseBuilder(
  (event: EventWithCount, _isClosed: boolean, _iframe: boolean) => ticketCsrfPath(event.slug),
  (token, error, event, isClosed, iframe) => ticketPage(event, token, error, isClosed, iframe),
);

/** Ticket response without cookie - for validation errors after CSRF passed */
const ticketResponse =
  (event: EventWithCount, token: string) =>
  (error: string, status = 400) =>
    htmlResponse(ticketPage(event, token, error), status);

/** Check if request URL has ?iframe=true */
const isIframeRequest = (url: string): boolean =>
  new URL(url).searchParams.get("iframe") === "true";

/**
 * Handle GET /ticket/:slug
 */
export const handleTicketGet = (slug: string, request: Request): Promise<Response> =>
  withActiveEventBySlug(slug, (event) => {
    const token = generateSecureToken();
    const closed = isRegistrationClosed(event);
    const iframe = isIframeRequest(request.url);
    return ticketResponseWithCookie(event, closed, iframe)(token)();
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
  phone: string;
  quantity: number;
  token: string;
};

/** Try to redirect to checkout, or return error using provided handler */
const tryCheckoutRedirect = <T>(
  sessionUrl: string | undefined | null,
  errorHandler: () => T,
): Response | T => (sessionUrl ? redirect(sessionUrl) : errorHandler());

/** Get active payment provider or return an error response */
const withPaymentProvider = async (
  onMissing: () => Response,
  fn: (provider: Awaited<ReturnType<typeof getActivePaymentProvider>> & object) => Promise<Response>,
): Promise<Response> => {
  const provider = await getActivePaymentProvider();
  return provider ? fn(provider) : onMissing();
};

/** Generic checkout flow: resolve provider, create session, redirect or show error */
const runCheckoutFlow = (
  label: string,
  request: Request,
  createSession: (
    provider: Awaited<ReturnType<typeof getActivePaymentProvider>> & object,
    baseUrl: string,
  ) => Promise<import("#lib/payments.ts").CheckoutSessionResult>,
  onError: (msg: string, status: number) => Response,
): Promise<Response> => {
  logDebug("Payment", `Starting ${label} checkout`);
  return withPaymentProvider(
    () => {
      logDebug("Payment", `No payment provider configured for ${label} checkout`);
      return onError("Payments are not configured. Please contact the administrator.", 500);
    },
    async (provider) => {
      logDebug("Payment", `Using provider=${provider.type} for ${label}`);
      const baseUrl = getBaseUrl(request);
      logDebug("Payment", `Creating checkout session baseUrl=${baseUrl}`);
      const result = await createSession(provider, baseUrl);
      logDebug("Payment", `Checkout result for ${label}: ${result ? `url=${result.checkoutUrl}` : "null"}`);
      return tryCheckoutRedirect(result?.checkoutUrl, () => {
        logDebug("Payment", `Checkout redirect failed for ${label}: no session URL`);
        return onError("Failed to create payment session. Please try again.", 500);
      });
    },
  );
};

/** Handle payment flow for single-ticket purchase */
const handlePaymentFlow = (
  request: Request,
  event: EventWithCount,
  intent: RegistrationIntent,
  csrfToken: string,
): Promise<Response> =>
  runCheckoutFlow(
    `single-ticket event=${event.id}`,
    request,
    (provider, baseUrl) => provider.createCheckoutSession(event, intent, baseUrl),
    (msg, status) => ticketResponse(event, csrfToken)(msg, status),
  );

/** Extract contact details (name, email, phone) from validated form values */
const extractContact = (values: import("#lib/forms.tsx").FieldValues) => ({
  name: values.name as string,
  email: (values.email as string) || "",
  phone: (values.phone as string) || "",
});

/** Parse and validate a quantity value from a raw string, capping at max */
const parseQuantityValue = (raw: string, max: number, minDefault = 1): number => {
  const quantity = Number.parseInt(raw, 10);
  if (Number.isNaN(quantity) || quantity < minDefault) return minDefault;
  return Math.min(quantity, max);
};

/** Parse quantity from single-ticket form */
const parseQuantity = (form: URLSearchParams, event: EventWithCount): number =>
  parseQuantityValue(form.get("quantity") || "1", event.max_quantity);

/** CSRF error response for ticket page */
const ticketCsrfError = (event: EventWithCount) => (token: string) =>
  ticketResponseWithCookie(event, false, false)(token)(
    "Invalid or expired form. Please try again.",
    403,
  );

/** Handle paid event registration - check availability, create Stripe session */
const processPaidReservation = async (
  request: Request,
  { event, token, ...contact }: ReservationParams,
): Promise<Response> => {
  const available = await hasAvailableSpots(event.id, contact.quantity);
  if (!available) {
    return ticketResponse(event, token)("Sorry, not enough spots available");
  }

  const intent: RegistrationIntent = { eventId: event.id, ...contact };
  return handlePaymentFlow(request, event, intent, token);
};

/** Format error message for failed attendee creation */
const formatAtomicError = formatCreationError(
  "Sorry, not enough spots available",
  (name) => `Sorry, ${name} no longer has enough spots available`,
  "Registration failed. Please try again.",
);

/** Handle free event registration - atomic create with capacity check */
const processFreeReservation = async (
  reservation: ReservationParams,
): Promise<Response> => {
  const { event, name, email, phone, quantity, token } = reservation;
  const result = await createAttendeeAtomic(event.id, name, email, null, quantity, phone);

  if (!result.success) {
    return ticketResponse(event, token)(formatAtomicError(result.reason));
  }

  await logAndNotifyRegistration(event, result.attendee, await getCurrencyCode());
  return redirect(event.thank_you_url || "/ticket/reserved");
};

/**
 * Process ticket reservation for an event.
 * - For paid events: creates Stripe session with intent, attendee created after payment
 * - For free events: atomically creates attendee with capacity check
 */
/** Registration closed message for form submissions */
const REGISTRATION_CLOSED_SUBMIT_MESSAGE =
  "Sorry, registration closed while you were submitting.";

const processTicketReservation = async (
  request: Request,
  event: EventWithCount,
): Promise<Response> => {
  const cookies = parseCookies(request);
  const currentToken = cookies.get("csrf_token") || generateSecureToken();

  const csrfResult = await requireCsrfForm(request, ticketCsrfError(event));
  if (!csrfResult.ok) return csrfResult.response;

  // Check if registration has closed since the form was loaded
  if (isRegistrationClosed(event)) {
    return ticketResponse(event, currentToken)(REGISTRATION_CLOSED_SUBMIT_MESSAGE);
  }

  const { form } = csrfResult;
  const fields = getTicketFields(event.fields);
  const validation = validateForm(form, fields);
  if (!validation.valid) {
    return ticketResponse(event, currentToken)(validation.error);
  }

  const quantity = parseQuantity(form, event);
  const contact = extractContact(validation.values);
  const params: ReservationParams = {
    event,
    ...contact,
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

/** Check if slug contains multiple events (has + separator) */
const isMultiSlug = (slug: string): boolean => slug.includes("+");

/** Parse multi-ticket slugs from a combined slug string */
const parseMultiSlugs = (slug: string): string[] =>
  slug.split("+").filter((s) => s.length > 0);

/** Filter and transform events to active multi-ticket events */
const getActiveMultiEvents = (
  events: (EventWithCount | null)[],
): MultiTicketEvent[] =>
  pipe(
    filter((e: EventWithCount) => e.active === 1),
    map((e: EventWithCount) => buildMultiTicketEvent(e, isRegistrationClosed(e))),
  )(compact(events));

/** CSRF path for multi-ticket form */
const multiTicketCsrfPath = (slugs: string[]): string =>
  `/ticket/${slugs.join("+")}`;

/** Multi-ticket response with CSRF cookie */
const multiTicketResponseWithCookie = makeCsrfResponseBuilder(
  (slugs: string[], _events: MultiTicketEvent[]) => multiTicketCsrfPath(slugs),
  (token, error, slugs, events) => multiTicketPage(events, slugs, token, error),
);

/** Multi-ticket response without cookie (for validation errors) */
const multiTicketResponse =
  (slugs: string[], events: MultiTicketEvent[], token: string) =>
  (error: string, status = 400) =>
    htmlResponse(multiTicketPage(events, slugs, token, error), status);

/** Load and validate active events for multi-ticket, return 404 if none */
const withActiveMultiEvents = async (
  slugs: string[],
  handler: (activeEvents: MultiTicketEvent[]) => Response | Promise<Response>,
): Promise<Response> => {
  const events = await getEventsBySlugsBatch(slugs);
  const activeEvents = getActiveMultiEvents(events);
  return activeEvents.length === 0 ? notFoundResponse() : handler(activeEvents);
};

/** Handle GET for multi-ticket page */
const handleMultiTicketGet = (slugs: string[]): Promise<Response> =>
  withActiveMultiEvents(slugs, (activeEvents) => {
    const token = generateSecureToken();
    return multiTicketResponseWithCookie(slugs, activeEvents)(token)();
  });

/** Parse quantity values from multi-ticket form */
const parseMultiQuantities = (
  form: URLSearchParams,
  events: MultiTicketEvent[],
): Map<number, number> => {
  const quantities = new Map<number, number>();

  for (const { event, isSoldOut, isClosed, maxPurchasable } of events) {
    if (isSoldOut || isClosed) continue;

    const raw = form.get(`quantity_${event.id}`) || "0";
    const quantity = parseQuantityValue(raw, maxPurchasable, 0);
    if (quantity > 0) {
      quantities.set(event.id, quantity);
    }
  }

  return quantities;
};

/** Filter events to those with selected quantity, returning event and quantity */
const eventsWithQuantity = (
  events: MultiTicketEvent[],
  quantities: Map<number, number>,
): Array<{ event: EventWithCount; qty: number }> =>
  pipe(
    map(({ event }: MultiTicketEvent) => ({
      event,
      qty: quantities.get(event.id) ?? 0,
    })),
    filter(({ qty }) => qty > 0),
  )(events) as Array<{ event: EventWithCount; qty: number }>;

/** Check if all selected events have available spots */
const checkMultiAvailability = async (
  events: MultiTicketEvent[],
  quantities: Map<number, number>,
): Promise<boolean> => {
  for (const { event, qty } of eventsWithQuantity(events, quantities)) {
    if (!(await hasAvailableSpots(event.id, qty))) return false;
  }
  return true;
};

/** Build multi-registration items from events and quantities */
const buildMultiRegistrationItems = (
  events: MultiTicketEvent[],
  quantities: Map<number, number>,
): MultiRegistrationItem[] =>
  pipe(
    filter(({ event }: MultiTicketEvent) => {
      const qty = quantities.get(event.id);
      return qty !== undefined && qty > 0;
    }),
    map(({ event }: MultiTicketEvent) => ({
      eventId: event.id,
      quantity: quantities.get(event.id) as number,
      unitPrice: event.unit_price ?? 0,
      slug: event.slug,
      name: event.name,
    })),
  )(events) as MultiRegistrationItem[];

/** Check if any selected event requires payment */
const anyRequiresPayment = async (
  items: MultiRegistrationItem[],
): Promise<boolean> => {
  const paymentsEnabled = await isPaymentsEnabled();
  if (!paymentsEnabled) return false;
  return items.some((item) => item.unitPrice > 0);
};

/** Handle payment flow for multi-ticket purchase */
const handleMultiPaymentFlow = (
  request: Request,
  slugs: string[],
  events: MultiTicketEvent[],
  intent: MultiRegistrationIntent,
  csrfToken: string,
): Promise<Response> =>
  runCheckoutFlow(
    `multi-ticket items=${intent.items.length}`,
    request,
    (provider, baseUrl) => provider.createMultiCheckoutSession(intent, baseUrl),
    (msg, status) => multiTicketResponse(slugs, events, csrfToken)(msg, status),
  );

/** Determine merged fields setting for multi-ticket events */
const getMultiTicketFieldsSetting = (events: MultiTicketEvent[]): EventFields =>
  mergeEventFields(events.map((e) => e.event.fields));

/** Handle free multi-ticket registration */
const processMultiFreeReservation = async (
  events: MultiTicketEvent[],
  quantities: Map<number, number>,
  name: string,
  email: string,
  phone: string,
): Promise<{ success: true } | { success: false; error: string }> => {
  const entries: Array<{ event: MultiTicketEvent["event"]; attendee: { id: number; quantity: number; name: string; email: string; phone: string; ticket_token: string } }> = [];
  for (const { event, qty } of eventsWithQuantity(events, quantities)) {
    const result = await createAttendeeAtomic(event.id, name, email, null, qty, phone);
    if (!result.success) {
      return { success: false, error: formatAtomicError(result.reason, event.name) };
    }
    entries.push({ event, attendee: result.attendee });
  }
  await logAndNotifyMultiRegistration(entries, await getCurrencyCode());
  return { success: true };
};

/** Handle POST for multi-ticket registration */
const handleMultiTicketPost = (
  request: Request,
  slugs: string[],
): Promise<Response> =>
  withActiveMultiEvents(slugs, async (activeEvents) => {
    const cookies = parseCookies(request);
  const currentToken = cookies.get("csrf_token") || generateSecureToken();

  // CSRF validation
  const csrfError = (token: string) =>
    multiTicketResponseWithCookie(slugs, activeEvents)(token)(
      "Invalid or expired form. Please try again.",
      403,
    );

  const csrfResult = await requireCsrfForm(request, csrfError);
  if (!csrfResult.ok) return csrfResult.response;

  const { form } = csrfResult;

  // Validate fields based on merged event settings
  const fieldsSetting = getMultiTicketFieldsSetting(activeEvents);
  const fields = getTicketFields(fieldsSetting);
  const validation = validateForm(form, fields);
  if (!validation.valid) {
    return multiTicketResponse(slugs, activeEvents, currentToken)(
      validation.error,
    );
  }

  const { name, email, phone } = extractContact(validation.values);

  // Check if any event the user selected is now closed
  for (const { event, isClosed } of activeEvents) {
    const selectedQty = Number.parseInt(form.get(`quantity_${event.id}`) || "0", 10);
    if (isClosed && selectedQty > 0) {
      return multiTicketResponse(slugs, activeEvents, currentToken)(
        REGISTRATION_CLOSED_SUBMIT_MESSAGE,
      );
    }
  }

  // Parse quantities
  const quantities = parseMultiQuantities(form, activeEvents);

  // Check at least one ticket selected
  const totalQuantity = reduce((sum: number, qty: number) => sum + qty, 0)(
    Array.from(quantities.values()),
  );
  if (totalQuantity === 0) {
    return multiTicketResponse(slugs, activeEvents, currentToken)(
      "Please select at least one ticket",
    );
  }

  // Build registration items
  const items = buildMultiRegistrationItems(activeEvents, quantities);

  // Check if payment required
  if (await anyRequiresPayment(items)) {
    // Check availability before creating Stripe session
    const available = await checkMultiAvailability(activeEvents, quantities);
    if (!available) {
      return multiTicketResponse(slugs, activeEvents, currentToken)(
        "Sorry, some tickets are no longer available",
      );
    }

    const intent: MultiRegistrationIntent = { name, email, phone, items };
    return handleMultiPaymentFlow(
      request,
      slugs,
      activeEvents,
      intent,
      currentToken,
    );
  }

  // Free registration
  const result = await processMultiFreeReservation(
    activeEvents,
    quantities,
    name,
    email,
    phone,
  );

  if (!result.success) {
    return multiTicketResponse(slugs, activeEvents, currentToken)(result.error);
  }

  return redirect("/ticket/reserved");
  });

/** Slug pattern for extracting slug from path */
const SLUG_PATTERN = /^\/ticket\/(.+)$/;

/** Extract slug from path */
const extractSlugFromPath = (path: string): string | null => {
  const match = path.match(SLUG_PATTERN);
  return match?.[1] ?? null;
};

/** Handle GET /ticket/reserved - reservation success page */
const handleReservedGet = (): Response =>
  htmlResponse(reservationSuccessPage());

/** Route ticket requests - handles both single and multi-ticket */
export const routeTicket = (
  request: Request,
  path: string,
  method: string,
): Promise<Response | null> => {
  // Handle /ticket/reserved before slug matching
  if (path === "/ticket/reserved" && method === "GET") {
    return Promise.resolve(handleReservedGet());
  }

  const slug = extractSlugFromPath(path);
  if (!slug) return Promise.resolve(null);

  // Check if this is a multi-ticket URL
  if (isMultiSlug(slug)) {
    const slugs = parseMultiSlugs(slug);

    if (method === "GET") {
      return handleMultiTicketGet(slugs);
    }
    if (method === "POST") {
      return handleMultiTicketPost(request, slugs);
    }
    return Promise.resolve(null);
  }

  // Single ticket
  if (method === "GET") {
    return handleTicketGet(slug, request);
  }
  if (method === "POST") {
    return handleTicketPost(request, slug);
  }

  return Promise.resolve(null);
};
