/**
 * Public routes - ticket reservation
 */

import { compact, filter, map, pipe, reduce } from "#fp";
import { buildCsrfCookie, getCsrfCookieName } from "#lib/cookies.ts";
import { getCurrencyCode, isPaymentsEnabled } from "#lib/config.ts";
import { getTermsAndConditionsFromDb } from "#lib/db/settings.ts";
import { getAvailableDates } from "#lib/dates.ts";
import { checkBatchAvailability, createAttendeeAtomic, hasAvailableSpots } from "#lib/db/attendees.ts";
import { getEventsBySlugsBatch } from "#lib/db/events.ts";
import { getActiveHolidays } from "#lib/db/holidays.ts";
import { validateForm } from "#lib/forms.tsx";
import {
  getActivePaymentProvider,
  type MultiRegistrationIntent,
  type MultiRegistrationItem,
  type RegistrationIntent,
} from "#lib/payments.ts";
import type { ContactInfo, EventFields, EventWithCount } from "#lib/types.ts";
import { logDebug } from "#lib/logger.ts";
import {
  logAndNotifyMultiRegistration,
  logAndNotifyRegistration,
  type RegistrationEntry,
} from "#lib/webhook.ts";
import {
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
import { getTicketFields, mergeEventFields, type TicketFormValues } from "#templates/fields.ts";
import { checkoutPopupPage, reservationSuccessPage } from "#templates/payment.tsx";
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
    getIframe?: (...params: P) => boolean,
  ) =>
  (...params: P) =>
  (token: string) =>
  (error?: string, status = 200) =>
    htmlResponseWithCookie(buildCsrfCookie("csrf_token", token, { path: getPath(...params), inIframe: getIframe?.(...params) }))(
      getContent(token, error, ...params),
      status,
    );

/** Path for ticket CSRF cookies */
const ticketCsrfPath = (slug: string): string => `/ticket/${slug}`;

/** Ticket response with CSRF cookie */
const ticketResponseWithCookie = makeCsrfResponseBuilder<
  [EventWithCount, boolean, boolean, string[] | undefined, string | null | undefined]
>(
  (event) => ticketCsrfPath(event.slug),
  (token, error, event, isClosed, inIframe, dates, terms) => ticketPage(event, token, error, isClosed, inIframe, dates, terms),
  (_ev, _cl, inIframe) => inIframe,
);

/** Curried error response: render(error) → (error, status) → Response */
const errorResponse =
  (render: (error: string) => string) =>
  (error: string, status = 400) =>
    htmlResponse(render(error), status);

/** Build a validation error responder from a page render function */
const validationErrorResponder = <Args extends unknown[]>(
  renderPage: (error: string, ...args: Args) => string,
) =>
(...args: Args) =>
  errorResponse((error) => renderPage(error, ...args));

/** Ticket response without cookie - for validation errors after CSRF passed */
const ticketResponse = validationErrorResponder(
  (error: string, event: EventWithCount, token: string, inIframe: boolean, dates: string[] | undefined, terms: string | null | undefined) =>
    ticketPage(event, token, error, false, inIframe, dates, terms),
);

/** Check if request URL has ?iframe=true */
const isIframeRequest = (url: string): boolean =>
  new URL(url).searchParams.get("iframe") === "true";

/**
 * Handle GET /ticket/:slug
 */
/** Compute available dates for a daily event, or undefined for standard */
const computeDatesForEvent = async (event: EventWithCount): Promise<string[] | undefined> => {
  if (event.event_type !== "daily") return undefined;
  return getAvailableDates(event, await getActiveHolidays());
};

export const handleTicketGet = (slug: string, request: Request): Promise<Response> =>
  withActiveEventBySlug(slug, async (event) => {
    const token = generateSecureToken();
    const closed = isRegistrationClosed(event);
    const inIframe = isIframeRequest(request.url);
    const dates = await computeDatesForEvent(event);
    const terms = await getTermsAndConditionsFromDb();
    return ticketResponseWithCookie(event, closed, inIframe, dates, terms)(token)();
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
type ReservationParams = ContactInfo & {
  event: EventWithCount;
  quantity: number;
  token: string;
  date: string | null;
};

/** Try to redirect to checkout, or return error using provided handler.
 * When iframe=true, returns a popup page instead of redirect since Stripe cannot run in iframes. */
const tryCheckoutRedirect = <T>(
  sessionUrl: string | undefined | null,
  inIframe: boolean,
  errorHandler: () => T,
): Response | T => {
  if (!sessionUrl) return errorHandler();
  return inIframe ? htmlResponse(checkoutPopupPage(sessionUrl)) : redirect(sessionUrl);
};

/** Get active payment provider or return an error response */
const withPaymentProvider = async (
  onMissing: () => Response,
  fn: (provider: Awaited<ReturnType<typeof getActivePaymentProvider>> & object) => Promise<Response>,
): Promise<Response> => {
  const provider = await getActivePaymentProvider();
  return provider ? fn(provider) : onMissing();
};

/** Generic checkout flow: resolve provider, create session, redirect or show error.
 * When iframe=true, opens checkout in a popup window instead of redirect. */
const runCheckoutFlow = (
  label: string,
  request: Request,
  inIframe: boolean,
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
      return tryCheckoutRedirect(result?.checkoutUrl, inIframe, () => {
        logDebug("Payment", `Checkout redirect failed for ${label}: no session URL`);
        return onError("Failed to create payment session. Please try again.", 500);
      });
    },
  );
};

/** Shared context for ticket page rendering */
type TicketContext = { dates: string[] | undefined; terms: string | null | undefined; inIframe: boolean };

/** Handle payment flow for single-ticket purchase */
const handlePaymentFlow = (
  request: Request,
  event: EventWithCount,
  intent: RegistrationIntent,
  csrfToken: string,
  ctx: TicketContext,
): Promise<Response> =>
  runCheckoutFlow(
    `single-ticket event=${event.id}`,
    request,
    ctx.inIframe,
    (provider, baseUrl) => provider.createCheckoutSession(event, intent, baseUrl),
    (msg, status) => ticketResponse(event, csrfToken, ctx.inIframe, undefined, ctx.terms)(msg, status),
  );

/** Extract contact details from validated form values */
const extractContact = (values: TicketFormValues): ContactInfo => ({
  name: values.name,
  email: values.email || "",
  phone: values.phone || "",
  address: values.address || "",
  special_instructions: values.special_instructions || "",
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
const ticketCsrfError = (event: EventWithCount, inIframe: boolean, terms: string | null | undefined) => (token: string) =>
  ticketResponseWithCookie(event, false, inIframe, undefined, terms)(token)(
    "Invalid or expired form. Please try again.",
    403,
  );

/** Handle paid event registration - check availability, create Stripe session */
const processPaidReservation = async (
  request: Request,
  { event, token, ...contact }: ReservationParams,
  ctx: TicketContext,
): Promise<Response> => {
  const available = await hasAvailableSpots(event.id, contact.quantity, contact.date);
  if (!available) {
    return ticketResponse(event, token, ctx.inIframe, ctx.dates, ctx.terms)("Sorry, not enough spots available");
  }

  const intent: RegistrationIntent = { eventId: event.id, ...contact };
  return handlePaymentFlow(request, event, intent, token, ctx);
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
  ctx: TicketContext,
): Promise<Response> => {
  const { event, quantity, token, date, ...contact } = reservation;
  const result = await createAttendeeAtomic({ eventId: event.id, ...contact, quantity, date });

  if (!result.success) {
    return ticketResponse(event, token, ctx.inIframe, ctx.dates, ctx.terms)(formatAtomicError(result.reason));
  }

  await logAndNotifyRegistration(event, result.attendee, await getCurrencyCode());
  if (event.thank_you_url) return redirect(event.thank_you_url);
  return redirect(`/ticket/reserved?tokens=${encodeURIComponent(result.attendee.ticket_token)}`);
};

/**
 * Process ticket reservation for an event.
 * - For paid events: creates Stripe session with intent, attendee created after payment
 * - For free events: atomically creates attendee with capacity check
 */
/** Registration closed message for form submissions */
const REGISTRATION_CLOSED_SUBMIT_MESSAGE =
  "Sorry, registration closed while you were submitting.";

/** Extract CSRF token from request cookies, falling back to a fresh token */
const getFormToken = (request: Request): string => {
  const cookies = parseCookies(request);
  return cookies.get(getCsrfCookieName("csrf_token")) || generateSecureToken();
};

/** Validate submitted date against available dates; returns the date or null if invalid */
const validateSubmittedDate = (form: URLSearchParams, dates: string[]): string | null => {
  const submitted = form.get("date") || "";
  return submitted && dates.includes(submitted) ? submitted : null;
};

const processTicketReservation = async (
  request: Request,
  event: EventWithCount,
): Promise<Response> => {
  const currentToken = getFormToken(request);
  const terms = await getTermsAndConditionsFromDb();
  const inIframe = isIframeRequest(request.url);

  const csrfResult = await requireCsrfForm(request, ticketCsrfError(event, inIframe, terms));
  if (!csrfResult.ok) return csrfResult.response;

  // Check if registration has closed since the form was loaded
  if (isRegistrationClosed(event)) {
    return ticketResponse(event, currentToken, inIframe, undefined, terms)(REGISTRATION_CLOSED_SUBMIT_MESSAGE);
  }

  const { form } = csrfResult;
  const fields = getTicketFields(event.fields);
  const validation = validateForm<TicketFormValues>(form, fields);
  if (!validation.valid) {
    return ticketResponse(event, currentToken, inIframe, undefined, terms)(validation.error);
  }

  // Validate terms and conditions acceptance if configured
  if (terms && form.get("agree_terms") !== "1") {
    return ticketResponse(event, currentToken, inIframe, undefined, terms)("You must agree to the terms and conditions");
  }

  // For daily events, validate the submitted date against available dates
  let date: string | null = null;
  let dates: string[] | undefined;
  if (event.event_type === "daily") {
    dates = getAvailableDates(event, await getActiveHolidays());
    date = validateSubmittedDate(form, dates);
    if (!date) {
      return ticketResponse(event, currentToken, inIframe, dates, terms)("Please select a valid date");
    }
  }

  const quantity = parseQuantity(form, event);
  const contact = extractContact(validation.values);
  const params: ReservationParams = {
    event,
    ...contact,
    quantity,
    token: currentToken,
    date,
  };

  const ctx: TicketContext = { dates, terms, inIframe };
  if (await requiresPayment(event)) {
    return processPaidReservation(request, params, ctx);
  }
  return processFreeReservation(params, ctx);
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
const multiTicketResponseWithCookie = makeCsrfResponseBuilder<
  [string[], MultiTicketEvent[], string[] | undefined, string | null | undefined, boolean]
>(
  (slugs) => multiTicketCsrfPath(slugs),
  (token, error, slugs, events, dates, terms, inIframe) => multiTicketPage(events, slugs, token, error, dates, terms, inIframe),
  (_slugs, _events, _dates, _terms, inIframe) => inIframe,
);

/** Shared rendering context for multi-ticket error responses */
type MultiTicketRenderContext = {
  slugs: string[];
  events: MultiTicketEvent[];
  token: string;
  dates: string[];
  terms: string;
  inIframe: boolean;
};

/** Multi-ticket error response (for validation errors after CSRF passed) */
const multiTicketResponse = ({ events, slugs, token, dates, terms, inIframe }: MultiTicketRenderContext) =>
  errorResponse((error) => multiTicketPage(events, slugs, token, error, dates, terms, inIframe));

/** Load and validate active events for multi-ticket, return 404 if none */
const withActiveMultiEvents = async (
  slugs: string[],
  handler: (activeEvents: MultiTicketEvent[]) => Response | Promise<Response>,
): Promise<Response> => {
  const events = await getEventsBySlugsBatch(slugs);
  const activeEvents = getActiveMultiEvents(events);
  return activeEvents.length === 0 ? notFoundResponse() : handler(activeEvents);
};

/** Compute shared available dates across all daily events (intersection) */
const computeSharedDates = async (events: MultiTicketEvent[]): Promise<string[] | undefined> => {
  const dailyEvents = events.filter((e) => e.event.event_type === "daily");
  if (dailyEvents.length === 0) return undefined;
  const holidays = await getActiveHolidays();
  const dateSets = dailyEvents.map((e) => new Set(getAvailableDates(e.event, holidays)));
  return [...dateSets[0]!].filter((d) => dateSets.every((s) => s.has(d)));
};

/** Fetch shared context for multi-ticket pages: dates, terms */
const getMultiTicketContext = async (activeEvents: MultiTicketEvent[]): Promise<{ dates: string[]; terms: string }> => {
  const dates = await computeSharedDates(activeEvents);
  const terms = await getTermsAndConditionsFromDb();
  return { dates: dates ?? [], terms: terms ?? "" };
};

/** Handle GET for multi-ticket page */
const handleMultiTicketGet = (slugs: string[], request: Request): Promise<Response> =>
  withActiveMultiEvents(slugs, async (activeEvents) => {
    const token = generateSecureToken();
    const inIframe = isIframeRequest(request.url);
    const { dates, terms } = await getMultiTicketContext(activeEvents);
    return multiTicketResponseWithCookie(slugs, activeEvents, dates, terms, inIframe)(token)();
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

/** Event with selected quantity */
type EventQty = { event: EventWithCount; qty: number };

/** Filter events to those with selected quantity, returning event and quantity */
const eventsWithQuantity = (
  events: MultiTicketEvent[],
  quantities: Map<number, number>,
): EventQty[] => {
  const withQty: EventQty[] = map(({ event }: MultiTicketEvent) => ({
    event,
    qty: quantities.get(event.id) ?? 0,
  }))(events);
  return filter(({ qty }: EventQty) => qty > 0)(withQty);
};

/** Check if all selected events have available spots (single efficient query) */
const checkMultiAvailability = (
  events: MultiTicketEvent[],
  quantities: Map<number, number>,
  date?: string | null,
): Promise<boolean> =>
  checkBatchAvailability(
    eventsWithQuantity(events, quantities).map(({ event, qty }) => ({
      eventId: event.id,
      quantity: qty,
    })),
    date,
  );

/** Build multi-registration items from events and quantities */
const buildMultiRegistrationItems = (
  events: MultiTicketEvent[],
  quantities: Map<number, number>,
): MultiRegistrationItem[] => {
  const selected = filter(({ event }: MultiTicketEvent) => {
    const qty = quantities.get(event.id);
    return qty !== undefined && qty > 0;
  })(events);
  return map(({ event }: MultiTicketEvent) => ({
    eventId: event.id,
    quantity: quantities.get(event.id)!,
    unitPrice: event.unit_price ?? 0,
    slug: event.slug,
    name: event.name,
  }))(selected);
};

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
  intent: MultiRegistrationIntent,
  ctx: MultiTicketRenderContext,
): Promise<Response> =>
  runCheckoutFlow(
    `multi-ticket items=${intent.items.length}`,
    request,
    ctx.inIframe,
    (provider, baseUrl) => provider.createMultiCheckoutSession(intent, baseUrl),
    (msg, status) => multiTicketResponse(ctx)(msg, status),
  );

/** Determine merged fields setting for multi-ticket events */
const getMultiTicketFieldsSetting = (events: MultiTicketEvent[]): EventFields =>
  mergeEventFields(events.map((e) => e.event.fields));

/** Handle free multi-ticket registration */
const processMultiFreeReservation = async (
  events: MultiTicketEvent[],
  quantities: Map<number, number>,
  contact: ContactInfo,
  date: string | null,
): Promise<{ success: true; tokens: string[] } | { success: false; error: string }> => {
  const entries: RegistrationEntry[] = [];
  for (const { event, qty } of eventsWithQuantity(events, quantities)) {
    const eventDate = event.event_type === "daily" ? date : null;
    const result = await createAttendeeAtomic({ eventId: event.id, ...contact, quantity: qty, date: eventDate });
    if (!result.success) {
      return { success: false, error: formatAtomicError(result.reason, event.name) };
    }
    entries.push({ event, attendee: result.attendee });
  }
  await logAndNotifyMultiRegistration(entries, await getCurrencyCode());
  return { success: true, tokens: entries.map((entry) => entry.attendee.ticket_token) };
};

/** Handle POST for multi-ticket registration */
const handleMultiTicketPost = (
  request: Request,
  slugs: string[],
): Promise<Response> =>
  withActiveMultiEvents(slugs, async (activeEvents) => {
    const currentToken = getFormToken(request);
    const { dates, terms } = await getMultiTicketContext(activeEvents);
    const inIframe = isIframeRequest(request.url);
    const renderCtx: MultiTicketRenderContext = { slugs, events: activeEvents, token: currentToken, dates, terms, inIframe };

    // CSRF validation
    const csrfError = (token: string) =>
      multiTicketResponseWithCookie(slugs, activeEvents, dates, terms, inIframe)(token)(
        "Invalid or expired form. Please try again.",
        403,
      );

    const csrfResult = await requireCsrfForm(request, csrfError);
    if (!csrfResult.ok) return csrfResult.response;

    const { form } = csrfResult;

    // Validate fields based on merged event settings
    const fieldsSetting = getMultiTicketFieldsSetting(activeEvents);
    const fields = getTicketFields(fieldsSetting);
    const validation = validateForm<TicketFormValues>(form, fields);
    if (!validation.valid) {
      return multiTicketResponse(renderCtx)(
        validation.error,
      );
    }

    // Validate terms and conditions acceptance if configured
    if (terms && form.get("agree_terms") !== "1") {
      return multiTicketResponse(renderCtx)(
        "You must agree to the terms and conditions",
      );
    }

    const contact = extractContact(validation.values);

    // For daily events, validate the submitted date
    let date: string | null = null;
    if (dates.length > 0) {
      date = validateSubmittedDate(form, dates);
      if (!date) {
        return multiTicketResponse(renderCtx)(
          "Please select a valid date",
        );
      }
    }

    // Check if any event the user selected is now closed
    for (const { event, isClosed } of activeEvents) {
      const selectedQty = Number.parseInt(form.get(`quantity_${event.id}`) || "0", 10);
      if (isClosed && selectedQty > 0) {
        return multiTicketResponse(renderCtx)(
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
      return multiTicketResponse(renderCtx)(
        "Please select at least one ticket",
      );
    }

    // Build registration items
    const items = buildMultiRegistrationItems(activeEvents, quantities);

    // Check if payment required
    if (await anyRequiresPayment(items)) {
      // Check availability before creating checkout session
      const available = await checkMultiAvailability(activeEvents, quantities, date);
      if (!available) {
        return multiTicketResponse(renderCtx)(
          "Sorry, some tickets are no longer available",
        );
      }

      const intent: MultiRegistrationIntent = { ...contact, date, items };
      return handleMultiPaymentFlow(request, intent, renderCtx);
    }

    // Free registration
    const result = await processMultiFreeReservation(
      activeEvents,
      quantities,
      contact,
      date,
    );

    if (!result.success) {
      return multiTicketResponse(renderCtx)(result.error);
    }

    return redirect(`/ticket/reserved?tokens=${encodeURIComponent(result.tokens.join("+"))}`);
  });

/** Slug pattern for extracting slug from path */
const SLUG_PATTERN = /^\/ticket\/(.+)$/;

/** Extract slug from path */
const extractSlugFromPath = (path: string): string | null => {
  const match = path.match(SLUG_PATTERN);
  return match?.[1] ?? null;
};

/** Handle GET /ticket/reserved - reservation success page */
const handleReservedGet = (request: Request): Response => {
  const tokensParam = new URL(request.url).searchParams.get("tokens");
  const normalizedTokens = tokensParam?.replaceAll(" ", "+") ?? "";
  const tokens = normalizedTokens.split("+").filter((t) => t.length > 0);
  const ticketUrl = tokens.length > 0 ? `/t/${tokens.join("+")}` : null;
  return htmlResponse(reservationSuccessPage(ticketUrl));
};

/** Route ticket requests - handles both single and multi-ticket */
export const routeTicket = (
  request: Request,
  path: string,
  method: string,
): Promise<Response | null> => {
  // Handle /ticket/reserved before slug matching
  if (path === "/ticket/reserved" && method === "GET") {
    return Promise.resolve(handleReservedGet(request));
  }

  const slug = extractSlugFromPath(path);
  if (!slug) return Promise.resolve(null);

  // Check if this is a multi-ticket URL
  if (isMultiSlug(slug)) {
    const slugs = parseMultiSlugs(slug);

    if (method === "GET") {
      return handleMultiTicketGet(slugs, request);
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
