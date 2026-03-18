/**
 * Public routes - ticket reservation
 */

import { compact, filter, map, pipe, reduce } from "#fp";
import { type BookingResult, processBooking } from "#lib/booking.ts";
import {
  getAllowedDomain,
  getCurrencyCode,
  isPaymentsEnabled,
} from "#lib/config.ts";
import { signCsrfToken } from "#lib/csrf.ts";
import { validatePrice } from "#lib/currency.ts";
import { getAvailableDates } from "#lib/dates.ts";
import {
  checkBatchAvailability,
  createAttendeeAtomic,
} from "#lib/db/attendees.ts";
import {
  getAllEvents,
  getEventsBySlugsBatch,
  getEventWithCountBySlug,
} from "#lib/db/events.ts";
import {
  computeGroupSlugIndex,
  getActiveEventsByGroupId,
  getGroupBySlugIndex,
} from "#lib/db/groups.ts";
import { getActiveHolidays } from "#lib/db/holidays.ts";
import {
  getQuestionsForEvent,
  getQuestionsForEvents,
  type QuestionWithAnswers,
  saveAttendeeAnswers,
  saveAttendeeAnswersBatch,
} from "#lib/db/questions.ts";
import {
  getContactPageTextFromDb,
  getHomepageTextFromDb,
  getShowPublicSiteFromDb,
  getTermsAndConditionsFromDb,
  getWebsiteTitleFromDb,
} from "#lib/db/settings.ts";
import { ATTENDEE_DEMO_FIELDS, applyDemoOverrides } from "#lib/demo.ts";
import type { EmailEntry } from "#lib/email.ts";
import { getEmailConfig, getHostEmailConfig } from "#lib/email.ts";
import type { FormParams } from "#lib/form-data.ts";
import { logDebug } from "#lib/logger.ts";
import {
  getActivePaymentProvider,
  type MultiRegistrationIntent,
  type MultiRegistrationItem,
} from "#lib/payments.ts";
import { generateQrSvg } from "#lib/qr.ts";
import { sortEvents } from "#lib/sort-events.ts";
import {
  type ContactInfo,
  type EventFields,
  type EventWithCount,
  type Group,
  isPaidEvent,
} from "#lib/types.ts";
import { logAndNotifyMultiRegistration } from "#lib/webhook.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import {
  checkoutResponse,
  formatCreationError,
  getBaseUrl,
  htmlResponse,
  isRegistrationClosed,
  notFoundResponse,
  redirectResponse,
  withActiveEventBySlug,
  withCsrfForm,
} from "#routes/utils.ts";
import {
  extractContact,
  mergeEventFields,
  tryValidateTicketFields,
} from "#templates/fields.ts";
import { successPage } from "#templates/payment.tsx";
import {
  buildMultiTicketEvent,
  homepagePage,
  type MultiTicketEvent,
  multiTicketPage,
  type PublicPageType,
  publicSitePage,
  ticketPage,
} from "#templates/public.tsx";

/** Load active events for the homepage, sorted and with registration status */
const loadHomepageEvents = async (): Promise<MultiTicketEvent[]> => {
  const [allEvents, holidays] = await Promise.all([
    getAllEvents(),
    getActiveHolidays(),
  ]);
  const sorted = sortEvents(
    allEvents.filter((e) => e.active && !e.hidden),
    holidays,
  );
  return sorted.map((e) => buildMultiTicketEvent(e, isRegistrationClosed(e)));
};

/** Guard: redirect to admin if public site is disabled */
const requirePublicSite = async (
  fn: () => Promise<Response>,
): Promise<Response> =>
  (await getShowPublicSiteFromDb()) ? fn() : redirectResponse("/admin/");

/** Render a public site page with website title and content fetched in parallel */
const renderPublicPage = (
  pageType: PublicPageType,
  getContent: () => Promise<string | null>,
): Promise<Response> =>
  requirePublicSite(async () => {
    const [websiteTitle, content] = await Promise.all([
      getWebsiteTitleFromDb(),
      getContent(),
    ]);
    return htmlResponse(publicSitePage(pageType, websiteTitle, content));
  });

/** Handle GET / (home page) - redirect to admin or show public site */
export const handleHome = (): Promise<Response> =>
  renderPublicPage("home", getHomepageTextFromDb);

/** Handle GET /events - public events listing */
export const handlePublicEvents = (): Promise<Response> =>
  requirePublicSite(async () => {
    const [events, websiteTitle] = await Promise.all([
      loadHomepageEvents(),
      getWebsiteTitleFromDb(),
    ]);
    return htmlResponse(homepagePage(events, websiteTitle));
  });

/** Handle GET /terms - public terms and conditions page */
export const handlePublicTerms = (): Promise<Response> =>
  renderPublicPage("terms", getTermsAndConditionsFromDb);

/** Handle GET /contact - public contact page */
export const handlePublicContact = (): Promise<Response> =>
  renderPublicPage("contact", getContactPageTextFromDb);

/** Render a ticket page with the given context */
const renderTicketPage = (
  event: EventWithCount,
  ctx: TicketContext,
  opts: { isClosed?: boolean; baseUrl?: string; error?: string },
) =>
  ticketPage(
    event,
    opts.error,
    opts.isClosed ?? false,
    ctx.dates,
    ctx.terms,
    opts.baseUrl,
    ctx.questions,
  );

/** Ticket response builder (CSRF token auto-embedded by CsrfForm) */
const ticketResponseWithToken =
  (event: EventWithCount, ctx: TicketContext, opts: { isClosed?: boolean; baseUrl?: string } = {}) =>
  (error?: string, status = 200) =>
    htmlResponse(renderTicketPage(event, ctx, { ...opts, error }), status);

/** Curried error response: render(error) → (error, status) → Response */
const errorResponse =
  (render: (error: string) => string) =>
  (error: string, status = 400) =>
    htmlResponse(render(error), status);

/** Ticket error response - for validation errors after CSRF passed */
const ticketError =
  (event: EventWithCount, ctx: TicketContext) =>
  (error: string, status = 400) =>
    htmlResponse(renderTicketPage(event, ctx, { error }), status);

/** Compute available dates for a daily event, or undefined for standard */
const computeDatesForEvent = async (
  event: EventWithCount,
): Promise<string[] | undefined> => {
  if (event.event_type !== "daily") return undefined;
  return getAvailableDates(event, await getActiveHolidays());
};

/** Set noindex signal header on response for hidden events */
const applyHiddenNoindex = (response: Response, hidden: boolean): Response => {
  if (hidden) response.headers.set("x-robots-noindex", "true");
  return response;
};

/** Handle GET for a single-ticket page */
const handleSingleTicketGet = (
  slug: string,
  request: Request,
): Promise<Response> =>
  withActiveEventBySlug(slug, async (event) => {
    const closed = isRegistrationClosed(event);
    await signCsrfToken();
    const [dates, terms, questions] = await Promise.all([
      computeDatesForEvent(event),
      getTermsAndConditionsFromDb(),
      getQuestionsForEvent(event.id),
    ]);
    const ctx: TicketContext = { dates, terms, questions };
    return applyHiddenNoindex(
      ticketResponseWithToken(event, ctx, { isClosed: closed, baseUrl: getBaseUrl(request) })(),
      event.hidden,
    );
  });

/** Map a BookingResult to a web response for single-ticket pages */
const bookingResultToWebResponse = (
  result: BookingResult,
  event: EventWithCount,
  ctx: TicketContext,
  answerIds: number[] = [],
): Response => {
  const showError = ticketError(event, ctx);
  switch (result.type) {
    case "success": {
      if (answerIds.length > 0) {
        saveAttendeeAnswers(result.attendee.id, answerIds);
      }
      if (event.thank_you_url) return redirectResponse(event.thank_you_url);
      return redirectResponse(
        `/ticket/reserved?tokens=${encodeURIComponent(result.attendee.ticket_token)}`,
      );
    }
    case "checkout":
      return checkoutResponse(result.checkoutUrl);
    case "sold_out":
      return showError("Sorry, not enough spots available");
    case "checkout_failed":
      return result.error
        ? showError(result.error)
        : showError("Failed to create payment session. Please try again.", 500);
    case "creation_failed":
      return showError(formatAtomicError(result.reason));
  }
};

/** Try to redirect to checkout, or return error using provided handler.
 * When in iframe mode, returns a popup page instead of redirect since Stripe cannot run in iframes. */
const tryCheckoutRedirect = <T>(
  sessionUrl: string | undefined | null,
  errorHandler: () => T,
): Response | T => {
  if (!sessionUrl) return errorHandler();
  return checkoutResponse(sessionUrl);
};

/** Get active payment provider or return an error response */
const withPaymentProvider = async (
  onMissing: () => Response,
  fn: (
    provider: Awaited<ReturnType<typeof getActivePaymentProvider>> & object,
  ) => Promise<Response>,
): Promise<Response> => {
  const provider = await getActivePaymentProvider();
  return provider ? fn(provider) : onMissing();
};

/** Generic checkout flow: resolve provider, create session, redirect or show error.
 * When in iframe mode, opens checkout in a popup window instead of redirect. */
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
      logDebug(
        "Payment",
        `No payment provider configured for ${label} checkout`,
      );
      return onError(
        "Payments are not configured. Please contact the administrator.",
        500,
      );
    },
    async (provider) => {
      logDebug("Payment", `Using provider=${provider.type} for ${label}`);
      const baseUrl = getBaseUrl(request);
      logDebug("Payment", `Creating checkout session baseUrl=${baseUrl}`);
      const result = await createSession(provider, baseUrl);
      if (result && "error" in result) {
        logDebug(
          "Payment",
          `Checkout validation error for ${label}: ${result.error}`,
        );
        return onError(result.error, 400);
      }
      logDebug(
        "Payment",
        `Checkout result for ${label}: ${result ? `url=${result.checkoutUrl}` : "null"}`,
      );
      return tryCheckoutRedirect(result?.checkoutUrl, () => {
        logDebug(
          "Payment",
          `Checkout redirect failed for ${label}: no session URL`,
        );
        return onError(
          "Failed to create payment session. Please try again.",
          500,
        );
      });
    },
  );
};

/** Shared context for ticket page rendering */
type TicketContext = {
  dates: string[] | undefined;
  terms: string | null | undefined;
  questions: QuestionWithAnswers[];
};

/** Parse and validate a quantity value from a raw string, capping at max */
const parseQuantityValue = (
  raw: string,
  max: number,
  minDefault = 1,
): number => {
  const quantity = Number.parseInt(raw, 10);
  if (Number.isNaN(quantity) || quantity < minDefault) return minDefault;
  return Math.min(quantity, max);
};

/** Parse quantity from single-ticket form */
const parseQuantity = (form: FormParams, event: EventWithCount): number =>
  parseQuantityValue(form.get("quantity") || "1", event.max_quantity);

/** Parse and validate a custom unit price from a form field.
 * Returns the price in minor units, or an error string if invalid. */
const parseCustomPrice = (
  form: FormParams,
  fieldName: string,
  minPrice: number,
  maxPrice: number,
) => validatePrice(form.getString(fieldName), minPrice, maxPrice);

/** Format error message for failed attendee creation */
const formatAtomicError = formatCreationError(
  "Sorry, not enough spots available",
  (name) => `Sorry, ${name} no longer has enough spots available`,
  "Registration failed. Please try again.",
);

/** Parse and validate answers for custom questions from form data.
 * Returns answer IDs if valid, or an error message if any required question is unanswered. */
const parseQuestionAnswers = (
  form: URLSearchParams,
  questions: QuestionWithAnswers[],
): { ok: true; answerIds: number[] } | { ok: false; error: string } => {
  const answerIds: number[] = [];
  for (const q of questions) {
    const raw = form.get(`question_${q.id}`);
    if (!raw) {
      return { ok: false, error: `Please answer: ${q.text}` };
    }
    const answerId = Number.parseInt(raw, 10);
    const validAnswer = q.answers.some((a) => a.id === answerId);
    if (!validAnswer) {
      return { ok: false, error: `Invalid answer for: ${q.text}` };
    }
    answerIds.push(answerId);
  }
  return { ok: true, answerIds };
};

/** Registration closed message for form submissions */
const REGISTRATION_CLOSED_SUBMIT_MESSAGE =
  "Sorry, registration closed while you were submitting.";

/** Validate submitted date against available dates; returns the date or null if invalid */
const validateSubmittedDate = (
  form: FormParams,
  dates: string[],
): string | null => {
  const submitted = form.getString("date");
  return submitted && dates.includes(submitted) ? submitted : null;
};

const processTicketReservation = async (
  request: Request,
  event: EventWithCount,
): Promise<Response> => {
  const [terms, questions] = await Promise.all([
    getTermsAndConditionsFromDb(),
    getQuestionsForEvent(event.id),
  ]);
  const ctx: TicketContext = { dates: undefined, terms, questions };
  const showError = ticketError(event, ctx);

  return withCsrfForm(
    request,
    (message, status) => ticketResponseWithToken(event, ctx)(message, status),
    async (form) => {
      if (isRegistrationClosed(event)) {
        return showError(REGISTRATION_CLOSED_SUBMIT_MESSAGE);
      }

      applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS);
      const valResult = tryValidateTicketFields(
        form,
        event.fields,
        (msg) => showError(msg),
        isPaidEvent(event),
      );
      if (valResult instanceof Response) return valResult;
      const values = valResult;

      if (terms && form.get("agree_terms") !== "1") {
        return showError("You must agree to the terms and conditions");
      }

      const answersResult = parseQuestionAnswers(form, questions);
      if (!answersResult.ok) return showError(answersResult.error);

      // For daily events, validate the submitted date against available dates
      if (event.event_type === "daily") {
        ctx.dates = getAvailableDates(event, await getActiveHolidays());
        const date = validateSubmittedDate(form, ctx.dates);
        if (!date) return showError("Please select a valid date");
      }

      const date = event.event_type === "daily"
        ? validateSubmittedDate(form, ctx.dates ?? [])
        : null;
      const quantity = parseQuantity(form, event);

      // Parse custom price for pay-more events
      let customUnitPrice: number | undefined;
      if (event.can_pay_more) {
        const priceResult = parseCustomPrice(
          form,
          "custom_price",
          event.unit_price,
          event.max_price,
        );
        if (!priceResult.ok) return showError(priceResult.error);
        customUnitPrice = priceResult.price;
      }

      const contact = extractContact(values);
      const bookingResult = await processBooking(
        event,
        contact,
        quantity,
        date,
        getBaseUrl(request),
        customUnitPrice,
      );
      return bookingResultToWebResponse(
        bookingResult,
        event,
        ctx,
        answersResult.answerIds,
      );
    },
  );
};

/** Handle POST for a single-ticket reservation */
const handleSingleTicketPost = (
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
    filter((e: EventWithCount) => e.active),
    map((e: EventWithCount) =>
      buildMultiTicketEvent(e, isRegistrationClosed(e)),
    ),
  )(compact(events));

/** Render multi-ticket HTML (CSRF token auto-embedded by CsrfForm) */
const renderMultiTicketPage = (ctx: MultiTicketCtx, error?: string) =>
  multiTicketPage({ ...ctx, error });

/** Multi-ticket response builder */
const multiTicketResponse =
  (ctx: MultiTicketCtx) =>
  (error?: string, status = 200) =>
    htmlResponse(renderMultiTicketPage(ctx, error), status);

/** Shared rendering context for multi-ticket error responses */
type MultiTicketCtx = {
  slugs: string[];
  events: MultiTicketEvent[];
  dates: string[];
  terms: string;
  questions: QuestionWithAnswers[];
};

/** Multi-ticket form error response (after CSRF passed) */
const multiTicketFormErrorResponse = (ctx: MultiTicketCtx) =>
  errorResponse((error) => renderMultiTicketPage(ctx, error));

/** Possibly-async response handler */
type AsyncHandler<T extends unknown[]> = (
  ...args: T
) => Response | Promise<Response>;

/** Load and validate active events for multi-ticket, return 404 if none */
const withActiveMultiEvents = async (
  slugs: string[],
  handler: AsyncHandler<[MultiTicketEvent[]]>,
): Promise<Response> => {
  const events = await getEventsBySlugsBatch(slugs);
  const active = compact(events).filter((e) => e.active);
  const activeEvents = active.map((e) =>
    buildMultiTicketEvent(e, isRegistrationClosed(e)),
  );
  return activeEvents.length === 0 ? notFoundResponse() : handler(activeEvents);
};

/** Compute shared available dates across all daily events (intersection) */
const computeSharedDates = async (
  events: MultiTicketEvent[],
): Promise<string[]> => {
  const dailyEvents = events.filter((e) => e.event.event_type === "daily");
  if (dailyEvents.length === 0) return [];
  const holidays = await getActiveHolidays();
  const dateSets = dailyEvents.map(
    (e) => new Set(getAvailableDates(e.event, holidays)),
  );
  return [...dateSets[0]!].filter((d) => dateSets.every((s) => s.has(d)));
};

/** Multi-ticket shared context shape */
type MultiTicketSharedContext = {
  dates: string[];
  terms: string;
  questions: QuestionWithAnswers[];
};

/** Fetch shared context for multi-ticket pages: dates, terms, questions */
const getMultiTicketContext = async (
  activeEvents: MultiTicketEvent[],
): Promise<MultiTicketSharedContext> => {
  const eventIds = activeEvents.map((e) => e.event.id);
  const [dates, terms, questions] = await Promise.all([
    computeSharedDates(activeEvents),
    getTermsAndConditionsFromDb(),
    getQuestionsForEvents(eventIds),
  ]);
  return { dates, terms: terms ?? "", questions };
};

/** Shared context provider for multi-ticket pages */
type MultiTicketContextProvider = (
  events: MultiTicketEvent[],
) => Promise<MultiTicketSharedContext>;

/** Load shared meta for multi-ticket pages */
const loadMultiTicketMeta = (
  activeEvents: MultiTicketEvent[],
  getContext: MultiTicketContextProvider,
): Promise<MultiTicketSharedContext> => getContext(activeEvents);

/** Handle POST for multi-ticket registration */
const submitMultiTicket = (
  request: Request,
  ctx: MultiTicketCtx,
): Promise<Response> =>
  withCsrfForm(
    request,
    (message, status) => multiTicketResponse(ctx)(message, status),
    async (form) => {
      const { dates, terms } = ctx;

      applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS);

      // Validate fields based on merged event settings
      const errorResponse = multiTicketFormErrorResponse(ctx);
      const anyPaid = ctx.events.some((e) => isPaidEvent(e.event));
      const fieldResult = tryValidateTicketFields(
        form,
        getMultiTicketFieldsSetting(ctx.events),
        errorResponse,
        anyPaid,
      );
      if (fieldResult instanceof Response) return fieldResult;
      const values = fieldResult;

      // Validate terms and conditions acceptance if configured
      if (terms && form.get("agree_terms") !== "1") {
        return errorResponse("You must agree to the terms and conditions");
      }

      // Validate custom question answers
      const answersResult = parseQuestionAnswers(form, ctx.questions);
      if (!answersResult.ok) {
        return errorResponse(answersResult.error);
      }

      const contact = extractContact(values);

      // For daily events, validate the submitted date
      let date: string | null = null;
      if (dates.length > 0) {
        date = validateSubmittedDate(form, dates);
        if (!date) {
          return multiTicketFormErrorResponse(ctx)(
            "Please select a valid date",
          );
        }
      }

      // Check if any event the user selected is now closed
      for (const { event, isClosed } of ctx.events) {
        const selectedQty = Number.parseInt(
          form.get(`quantity_${event.id}`) || "0",
          10,
        );
        if (isClosed && selectedQty > 0) {
          return multiTicketFormErrorResponse(ctx)(
            REGISTRATION_CLOSED_SUBMIT_MESSAGE,
          );
        }
      }

      // Parse quantities
      const quantities = parseMultiQuantities(form, ctx.events);

      // Check at least one ticket selected
      const totalQuantity = reduce(
        (sum: number, qty: number) => sum + qty,
        0,
      )(Array.from(quantities.values()));
      if (totalQuantity === 0) {
        return multiTicketFormErrorResponse(ctx)(
          "Please select at least one ticket",
        );
      }

      // Parse custom prices for pay-more events
      const customPrices = new Map<number, number>();
      for (const { event } of ctx.events) {
        if (event.can_pay_more) {
          const qty = quantities.get(event.id) ?? 0;
          if (qty > 0) {
            const priceResult = parseCustomPrice(
              form,
              `custom_price_${event.id}`,
              event.unit_price,
              event.max_price,
            );
            if (!priceResult.ok) {
              return multiTicketFormErrorResponse(ctx)(
                `${event.name}: ${priceResult.error}`,
              );
            }
            customPrices.set(event.id, priceResult.price);
          }
        }
      }

      // Build registration items
      const items = buildMultiRegistrationItems(
        ctx.events,
        quantities,
        customPrices,
      );

      // Check if payment required
      if (await anyRequiresPayment(items)) {
        const available = await checkMultiAvailability(
          ctx.events,
          quantities,
          date,
        );
        if (!available) {
          return multiTicketFormErrorResponse(ctx)(
            "Sorry, some tickets are no longer available",
          );
        }

        const intent: MultiRegistrationIntent = { ...contact, date, items };
        return handleMultiPaymentFlow(request, intent, ctx);
      }

      // Free registration
      const result = await processMultiFreeReservation(
        ctx.events,
        quantities,
        contact,
        date,
      );

      if (!result.success) {
        return multiTicketFormErrorResponse(ctx)(result.error);
      }

      // Save answers for all created attendees in a single batch
      if (answersResult.answerIds.length > 0) {
        const attendeeIds = result.entries.map((e) => e.attendee.id);
        await saveAttendeeAnswersBatch(attendeeIds, answersResult.answerIds);
      }

      const tokens = encodeURIComponent(result.tokens.join("+"));
      return redirectResponse(`/ticket/reserved?tokens=${tokens}`);
    },
  );

const handleMultiTicket = async (
  request: Request,
  actionSlugs: string[],
  activeEvents: MultiTicketEvent[],
  getContext: MultiTicketContextProvider,
): Promise<Response> => {
  const [{ dates, terms, questions }] = await Promise.all([
    loadMultiTicketMeta(activeEvents, getContext),
    signCsrfToken(),
  ]);
  const ctx: MultiTicketCtx = {
    slugs: actionSlugs,
    events: activeEvents,
    dates,
    terms,
    questions,
  };
  const response =
    request.method === "GET"
      ? multiTicketResponse(ctx)()
      : await submitMultiTicket(request, ctx);
  const anyHidden = activeEvents.some((e) => e.event.hidden);
  return applyHiddenNoindex(response, anyHidden);
};

const handleMultiTicketBySlugs = (
  request: Request,
  slugs: string[],
): Promise<Response> =>
  withActiveMultiEvents(slugs, (activeEvents) =>
    handleMultiTicket(request, slugs, activeEvents, getMultiTicketContext),
  );

/** Parse quantity values from multi-ticket form */
const parseMultiQuantities = (
  form: FormParams,
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
  customPrices: Map<number, number>,
): MultiRegistrationItem[] => {
  const selected = filter(({ event }: MultiTicketEvent) => {
    const qty = quantities.get(event.id);
    return qty !== undefined && qty > 0;
  })(events);
  return map(({ event }: MultiTicketEvent) => ({
    eventId: event.id,
    quantity: quantities.get(event.id)!,
    unitPrice: customPrices.get(event.id) ?? event.unit_price,
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
  ctx: MultiTicketCtx,
): Promise<Response> =>
  runCheckoutFlow(
    `multi-ticket items=${intent.items.length}`,
    request,
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
): Promise<
  | { success: true; tokens: string[]; entries: EmailEntry[] }
  | { success: false; error: string }
> => {
  const entries: EmailEntry[] = [];
  for (const { event, qty } of eventsWithQuantity(events, quantities)) {
    const eventDate = event.event_type === "daily" ? date : null;
    const result = await createAttendeeAtomic({
      eventId: event.id,
      ...contact,
      quantity: qty,
      date: eventDate,
    });
    if (!result.success) {
      return {
        success: false,
        error: formatAtomicError(result.reason, event.name),
      };
    }
    entries.push({ event, attendee: result.attendee });
  }
  await logAndNotifyMultiRegistration(entries, await getCurrencyCode());
  return {
    success: true,
    tokens: entries.map((entry) => entry.attendee.ticket_token),
    entries,
  };
};

/** Context provider for group pages (terms override + shared dates) */
const getGroupMultiTicketContext =
  (group: Group): MultiTicketContextProvider =>
  async (events) => {
    const eventIds = events.map((e) => e.event.id);
    const [dates, globalTerms, questions] = await Promise.all([
      computeSharedDates(events),
      getTermsAndConditionsFromDb(),
      getQuestionsForEvents(eventIds),
    ]);
    const terms = group.terms_and_conditions || globalTerms || "";
    return { dates, terms, questions };
  };

/** Load group by slug and its active events, return 404 if empty */
const withActiveGroupEventsBySlug = async (
  slug: string,
  handler: AsyncHandler<[Group, MultiTicketEvent[]]>,
): Promise<Response> => {
  const slugIndex = await computeGroupSlugIndex(slug);
  const group = await getGroupBySlugIndex(slugIndex);
  if (!group) return notFoundResponse();

  const [events, holidays] = await Promise.all([
    getActiveEventsByGroupId(group.id),
    getActiveHolidays(),
  ]);
  const activeEvents = getActiveMultiEvents(sortEvents(events, holidays));
  return activeEvents.length === 0
    ? notFoundResponse()
    : handler(group, activeEvents);
};

const handleGroupTicketBySlug = (
  request: Request,
  slug: string,
): Promise<Response> =>
  withActiveGroupEventsBySlug(slug, (group, activeEvents) =>
    handleMultiTicket(
      request,
      [slug],
      activeEvents,
      getGroupMultiTicketContext(group),
    ),
  );

/** Get the email from-address if email is configured. Returns empty string if not. */
export const getFromEmailIfConfigured = async (): Promise<string> => {
  const config = (await getEmailConfig()) ?? getHostEmailConfig();
  return config?.fromAddress ?? "";
};

/** Handle GET /ticket/reserved - reservation success page */
const handleReservedGet = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const tokensParam = url.searchParams.get("tokens");
  const normalizedTokens = tokensParam?.replaceAll(" ", "+") ?? "";
  const tokens = normalizedTokens.split("+").filter((t) => t.length > 0);
  const ticketUrl = tokens.length > 0 ? `/t/${tokens.join("+")}` : null;
  const fromEmail = tokens.length > 0 ? await getFromEmailIfConfigured() : "";

  return htmlResponse(successPage({ ticketUrl, fromEmail }));
};

/** Create a slug route that dispatches single vs multi-ticket requests */
const slugRoute =
  (
    onSingle: (request: Request, slug: string) => Promise<Response>,
    onMulti: (request: Request, slugs: string[]) => Promise<Response>,
  ) =>
  (request: Request, { slug }: { slug: string }): Promise<Response> =>
    isMultiSlug(slug)
      ? onMulti(request, parseMultiSlugs(slug))
      : onSingle(request, slug);

/** Wrap a single-slug handler with group fallback on 404 */
const withGroupFallback =
  (fn: (request: Request, slug: string) => Promise<Response>) =>
  async (request: Request, slug: string): Promise<Response> => {
    const response = await fn(request, slug);
    return response.status === 404
      ? handleGroupTicketBySlug(request, slug)
      : response;
  };

/** Handle GET /ticket/:slug (event first, then group fallback) */
const handleTicketGet = slugRoute(
  withGroupFallback((request, slug) => handleSingleTicketGet(slug, request)),
  handleMultiTicketBySlugs,
);

/** Handle POST /ticket/:slug (event first, then group fallback) */
const handleTicketPost = slugRoute(
  withGroupFallback(handleSingleTicketPost),
  handleMultiTicketBySlugs,
);

/** Generate a QR code SVG response for a given slug */
const qrResponse = async (slug: string): Promise<Response> => {
  const ticketUrl = `https://${getAllowedDomain()}/ticket/${slug}`;
  const svg = await generateQrSvg(ticketUrl);
  return new Response(svg, {
    headers: { "content-type": "image/svg+xml" },
  });
};

/** Handle GET /ticket/:slug/qr (event first, then group fallback) */
export const handleTicketQrGet = async (
  _request: Request,
  { slug }: { slug: string },
): Promise<Response> => {
  const event = await getEventWithCountBySlug(slug);
  if (event) return qrResponse(slug);

  const slugIndex = await computeGroupSlugIndex(slug);
  const group = await getGroupBySlugIndex(slugIndex);
  if (group) return qrResponse(slug);

  return notFoundResponse();
};

/** Public ticket routes */
const publicRoutes = defineRoutes({
  "GET /ticket/reserved": handleReservedGet,
  "GET /ticket/:slug/qr": handleTicketQrGet,
  "GET /ticket/:slug": handleTicketGet,
  "POST /ticket/:slug": handleTicketPost,
});

/** Route ticket requests */
export const routeTicket = createRouter(publicRoutes);
