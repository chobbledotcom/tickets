/**
 * Public routes - ticket reservation
 */

import { compact, filter, map, pipe, reduce } from "#fp";
import { processBooking, type BookingResult } from "#lib/booking.ts";
import { signCsrfToken } from "#lib/csrf.ts";
import { validatePrice } from "#lib/currency.ts";
import { getAllowedDomain, getCurrencyCode, isPaymentsEnabled } from "#lib/config.ts";
import { applyDemoOverrides, ATTENDEE_DEMO_FIELDS } from "#lib/demo.ts";
import {
  getContactPageTextFromDb,
  getHomepageTextFromDb,
  getShowPublicSiteFromDb,
  getTermsAndConditionsFromDb,
  getWebsiteTitleFromDb,
} from "#lib/db/settings.ts";
import { getAvailableDates } from "#lib/dates.ts";
import { generateQrSvg } from "#lib/qr.ts";
import { sortEvents } from "#lib/sort-events.ts";
import { checkBatchAvailability, createAttendeeAtomic } from "#lib/db/attendees.ts";
import { getAllEvents, getEventsBySlugsBatch, getEventWithCountBySlug } from "#lib/db/events.ts";
import {
  computeGroupSlugIndex,
  getActiveEventsByGroupId,
  getGroupBySlugIndex,
} from "#lib/db/groups.ts";
import { getActiveHolidays } from "#lib/db/holidays.ts";
import {
  getActivePaymentProvider,
  type MultiRegistrationIntent,
  type MultiRegistrationItem,
} from "#lib/payments.ts";
import type { ContactInfo, EventFields, EventWithCount, Group } from "#lib/types.ts";
import { getMaxPrice } from "#lib/types.ts";
import { logDebug } from "#lib/logger.ts";
import {
  logAndNotifyMultiRegistration,
  type RegistrationEntry,
} from "#lib/webhook.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import {
  formatCreationError,
  getBaseUrl,
  htmlResponse,
  isRegistrationClosed,
  notFoundResponse,
  redirect,
  withCsrfForm,
  withActiveEventBySlug,
} from "#routes/utils.ts";
import { extractContact, mergeEventFields, tryValidateTicketFields } from "#templates/fields.ts";
import { checkoutPopupPage, reservationSuccessPage } from "#templates/payment.tsx";
import {
  buildMultiTicketEvent,
  homepagePage,
  type MultiTicketEvent,
  multiTicketPage,
  publicSitePage,
  type PublicPageType,
  ticketPage,
} from "#templates/public.tsx";

/** Load active events for the homepage, sorted and with registration status */
const loadHomepageEvents = async (): Promise<MultiTicketEvent[]> => {
  const [allEvents, holidays] = await Promise.all([getAllEvents(), getActiveHolidays()]);
  const sorted = sortEvents(allEvents.filter((e) => e.active && !e.hidden), holidays);
  return sorted.map((e) => buildMultiTicketEvent(e, isRegistrationClosed(e)));
};

/** Guard: redirect to admin if public site is disabled */
const requirePublicSite = async (fn: () => Promise<Response>): Promise<Response> =>
  await getShowPublicSiteFromDb() ? fn() : redirect("/admin/");

/** Render a public site page with website title and content fetched in parallel */
const renderPublicPage = (
  pageType: PublicPageType,
  getContent: () => Promise<string | null>,
): Promise<Response> =>
  requirePublicSite(async () => {
    const [websiteTitle, content] = await Promise.all([getWebsiteTitleFromDb(), getContent()]);
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

/** Ticket response builder (CSRF token auto-embedded by CsrfForm) */
const ticketResponseWithToken =
  (event: EventWithCount, isClosed: boolean, inIframe: boolean, dates: string[] | undefined, terms: string | null | undefined, baseUrl?: string) =>
  (error?: string, status = 200) =>
    htmlResponse(ticketPage(event, error, isClosed, inIframe, dates, terms, baseUrl), status);

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

/** Ticket error response - for validation errors after CSRF passed */
const ticketResponse = validationErrorResponder(
  (error: string, event: EventWithCount, inIframe: boolean, dates: string[] | undefined, terms: string | null | undefined) =>
    ticketPage(event, error, false, inIframe, dates, terms),
);

/** Check if request URL has ?iframe=true */
const isIframeRequest = (url: string): boolean =>
  new URL(url).searchParams.get("iframe") === "true";

/** Compute available dates for a daily event, or undefined for standard */
const computeDatesForEvent = async (event: EventWithCount): Promise<string[] | undefined> => {
  if (event.event_type !== "daily") return undefined;
  return getAvailableDates(event, await getActiveHolidays());
};

/** Set noindex signal header on response for hidden events */
const applyHiddenNoindex = (response: Response, hidden: boolean): Response => {
  if (hidden) response.headers.set("x-robots-noindex", "true");
  return response;
};

/** Handle GET for a single-ticket page */
const handleSingleTicketGet = (slug: string, request: Request): Promise<Response> =>
  withActiveEventBySlug(slug, async (event) => {
    const closed = isRegistrationClosed(event);
    const inIframe = isIframeRequest(request.url);
    await signCsrfToken();
    const dates = await computeDatesForEvent(event);
    const terms = await getTermsAndConditionsFromDb();
    const baseUrl = getBaseUrl(request);
    return applyHiddenNoindex(
      ticketResponseWithToken(event, closed, inIframe, dates, terms, baseUrl)(),
      event.hidden,
    );
  });

/** Map a BookingResult to a web response for single-ticket pages */
const bookingResultToWebResponse = (
  result: BookingResult,
  event: EventWithCount,
  ctx: TicketContext,
): Response => {
  switch (result.type) {
    case "success": {
      if (event.thank_you_url) return redirect(event.thank_you_url);
      const iframeParam = ctx.inIframe ? "&iframe=true" : "";
      return redirect(`/ticket/reserved?tokens=${encodeURIComponent(result.attendee.ticket_token)}${iframeParam}`);
    }
    case "checkout":
      return ctx.inIframe ? htmlResponse(checkoutPopupPage(result.checkoutUrl)) : redirect(result.checkoutUrl);
    case "sold_out":
      return ticketResponse(event, ctx.inIframe, ctx.dates, ctx.terms)("Sorry, not enough spots available");
    case "checkout_failed":
      return result.error
        ? ticketResponse(event, ctx.inIframe, ctx.dates, ctx.terms)(result.error, 400)
        : ticketResponse(event, ctx.inIframe, ctx.dates, ctx.terms)("Failed to create payment session. Please try again.", 500);
    case "creation_failed":
      return ticketResponse(event, ctx.inIframe, ctx.dates, ctx.terms)(
        formatAtomicError(result.reason),
      );
  }
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
      if (result && "error" in result) {
        logDebug("Payment", `Checkout validation error for ${label}: ${result.error}`);
        return onError(result.error, 400);
      }
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

/** Parse and validate a quantity value from a raw string, capping at max */
const parseQuantityValue = (raw: string, max: number, minDefault = 1): number => {
  const quantity = Number.parseInt(raw, 10);
  if (Number.isNaN(quantity) || quantity < minDefault) return minDefault;
  return Math.min(quantity, max);
};

/** Parse quantity from single-ticket form */
const parseQuantity = (form: URLSearchParams, event: EventWithCount): number =>
  parseQuantityValue(form.get("quantity") || "1", event.max_quantity);

/** Parse and validate a custom unit price from a form field.
 * Returns the price in minor units, or an error string if invalid. */
const parseCustomPrice = (
  form: URLSearchParams,
  fieldName: string,
  minPrice: number,
  maxPrice: number,
) => validatePrice((form.get(fieldName) || "").trim(), minPrice, maxPrice);

/** Format error message for failed attendee creation */
const formatAtomicError = formatCreationError(
  "Sorry, not enough spots available",
  (name) => `Sorry, ${name} no longer has enough spots available`,
  "Registration failed. Please try again.",
);

/** Registration closed message for form submissions */
const REGISTRATION_CLOSED_SUBMIT_MESSAGE =
  "Sorry, registration closed while you were submitting.";

/** Validate submitted date against available dates; returns the date or null if invalid */
const validateSubmittedDate = (form: URLSearchParams, dates: string[]): string | null => {
  const submitted = form.get("date") || "";
  return submitted && dates.includes(submitted) ? submitted : null;
};

const processTicketReservation = async (
  request: Request,
  event: EventWithCount,
): Promise<Response> => {
  const terms = await getTermsAndConditionsFromDb();
  const inIframe = isIframeRequest(request.url);

  return withCsrfForm(
    request,
    (message, status) =>
      ticketResponseWithToken(event, false, inIframe, undefined, terms)(
        message,
        status,
      ),
    async (form) => {
      // Check if registration has closed since the form was loaded
      if (isRegistrationClosed(event)) {
        return ticketResponse(event, inIframe, undefined, terms)(
          REGISTRATION_CLOSED_SUBMIT_MESSAGE,
        );
      }

      applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS);
      const valResult = tryValidateTicketFields(
        form, event.fields,
        (msg) => ticketResponse(event, inIframe, undefined, terms)(msg),
      );
      if (valResult instanceof Response) return valResult;
      const values = valResult;

      // Validate terms and conditions acceptance if configured
      if (terms && form.get("agree_terms") !== "1") {
        return ticketResponse(event, inIframe, undefined, terms)(
          "You must agree to the terms and conditions",
        );
      }

      // For daily events, validate the submitted date against available dates
      let date: string | null = null;
      let dates: string[] | undefined;
      if (event.event_type === "daily") {
        dates = getAvailableDates(event, await getActiveHolidays());
        date = validateSubmittedDate(form, dates);
        if (!date) {
          return ticketResponse(event, inIframe, dates, terms)(
            "Please select a valid date",
          );
        }
      }

      const quantity = parseQuantity(form, event);

      // Parse custom price for pay-more events
      let customUnitPrice: number | undefined;
      if (event.can_pay_more) {
        const priceResult = parseCustomPrice(form, "custom_price", event.unit_price, getMaxPrice(event));
        if (!priceResult.ok) {
          return ticketResponse(event, inIframe, dates, terms)(priceResult.error);
        }
        customUnitPrice = priceResult.price;
      }

      const ctx: TicketContext = { dates, terms, inIframe };
      const contact = extractContact(values);
      const bookingResult = await processBooking(event, contact, quantity, date, getBaseUrl(request), customUnitPrice);
      return bookingResultToWebResponse(bookingResult, event, ctx);
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
    map((e: EventWithCount) => buildMultiTicketEvent(e, isRegistrationClosed(e))),
  )(compact(events));

/** Render multi-ticket HTML (CSRF token auto-embedded by CsrfForm) */
const renderMultiTicketPage = (ctx: MultiTicketCtx, error?: string) =>
  multiTicketPage(
    ctx.events,
    ctx.slugs,
    error,
    ctx.dates,
    ctx.terms,
    ctx.inIframe,
  );

/** Multi-ticket response builder */
const multiTicketResponse = (ctx: MultiTicketCtx) =>
  (error?: string, status = 200) => htmlResponse(renderMultiTicketPage(ctx, error), status);

/** Shared rendering context for multi-ticket error responses */
type MultiTicketCtx = {
  slugs: string[];
  events: MultiTicketEvent[];
  dates: string[];
  terms: string;
  inIframe: boolean;
};

/** Multi-ticket form error response (after CSRF passed) */
const multiTicketFormErrorResponse = (ctx: MultiTicketCtx) =>
  errorResponse((error) => renderMultiTicketPage(ctx, error));

/** Possibly-async response handler */
type AsyncHandler<T extends unknown[]> = (...args: T) => Response | Promise<Response>;

/** Load and validate active events for multi-ticket, return 404 if none */
const withActiveMultiEvents = async (
  slugs: string[],
  handler: AsyncHandler<[MultiTicketEvent[]]>,
): Promise<Response> => {
  const [events, holidays] = await Promise.all([getEventsBySlugsBatch(slugs), getActiveHolidays()]);
  const active = compact(events).filter((e) => e.active);
  const sorted = sortEvents(active, holidays);
  const activeEvents = sorted.map((e) => buildMultiTicketEvent(e, isRegistrationClosed(e)));
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

/** Shared context provider for multi-ticket pages */
type MultiTicketContextProvider = (events: MultiTicketEvent[]) => Promise<{ dates: string[]; terms: string }>;

/** Load shared meta for multi-ticket pages */
const loadMultiTicketMeta = async (
  request: Request,
  activeEvents: MultiTicketEvent[],
  getContext: MultiTicketContextProvider,
): Promise<{ inIframe: boolean; dates: string[]; terms: string }> => {
  const inIframe = isIframeRequest(request.url);
  const { dates, terms } = await getContext(activeEvents);
  return { inIframe, dates, terms };
};

/** Handle POST for multi-ticket registration */
const submitMultiTicket = (
  request: Request,
  ctx: MultiTicketCtx,
): Promise<Response> =>
  withCsrfForm(
    request,
    (message, status) =>
      multiTicketResponse(ctx)(message, status),
    async (form) => {
      const { inIframe, dates, terms } = ctx;

      applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS);

      // Validate fields based on merged event settings
      const errorResponse = multiTicketFormErrorResponse(ctx);
      const fieldResult = tryValidateTicketFields(
        form, getMultiTicketFieldsSetting(ctx.events), errorResponse,
      );
      if (fieldResult instanceof Response) return fieldResult;
      const values = fieldResult;

      // Validate terms and conditions acceptance if configured
      if (terms && form.get("agree_terms") !== "1") {
        return errorResponse("You must agree to the terms and conditions");
      }

      const contact = extractContact(values);

      // For daily events, validate the submitted date
      let date: string | null = null;
      if (dates.length > 0) {
        date = validateSubmittedDate(form, dates);
        if (!date) {
          return multiTicketFormErrorResponse(ctx)("Please select a valid date");
        }
      }

      // Check if any event the user selected is now closed
      for (const { event, isClosed } of ctx.events) {
        const selectedQty = Number.parseInt(
          form.get(`quantity_${event.id}`) || "0",
          10,
        );
        if (isClosed && selectedQty > 0) {
          return multiTicketFormErrorResponse(ctx)(REGISTRATION_CLOSED_SUBMIT_MESSAGE);
        }
      }

      // Parse quantities
      const quantities = parseMultiQuantities(form, ctx.events);

      // Check at least one ticket selected
      const totalQuantity = reduce((sum: number, qty: number) => sum + qty, 0)(
        Array.from(quantities.values()),
      );
      if (totalQuantity === 0) {
        return multiTicketFormErrorResponse(ctx)("Please select at least one ticket");
      }

      // Parse custom prices for pay-more events
      const customPrices = new Map<number, number>();
      for (const { event } of ctx.events) {
        if (event.can_pay_more) {
          const qty = quantities.get(event.id) ?? 0;
          if (qty > 0) {
            const priceResult = parseCustomPrice(form, `custom_price_${event.id}`, event.unit_price, getMaxPrice(event));
            if (!priceResult.ok) {
              return multiTicketFormErrorResponse(ctx)(`${event.name}: ${priceResult.error}`);
            }
            customPrices.set(event.id, priceResult.price);
          }
        }
      }

      // Build registration items
      const items = buildMultiRegistrationItems(ctx.events, quantities, customPrices);

      // Check if payment required
      if (await anyRequiresPayment(items)) {
        const available = await checkMultiAvailability(ctx.events, quantities, date);
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

      const iframeParam = inIframe ? "&iframe=true" : "";
      const tokens = encodeURIComponent(result.tokens.join("+"));
      return redirect(`/ticket/reserved?tokens=${tokens}${iframeParam}`);
    },
  );

const handleMultiTicket = async (
  request: Request,
  actionSlugs: string[],
  activeEvents: MultiTicketEvent[],
  getContext: MultiTicketContextProvider,
): Promise<Response> => {
  const [{ inIframe, dates, terms }] = await Promise.all([
    loadMultiTicketMeta(request, activeEvents, getContext),
    signCsrfToken(),
  ]);
  const ctx: MultiTicketCtx = {
    slugs: actionSlugs,
    events: activeEvents,
    dates,
    terms,
    inIframe,
  };
  const response = request.method === "GET"
    ? multiTicketResponse(ctx)()
    : await submitMultiTicket(request, ctx);
  const anyHidden = activeEvents.some((e) => e.event.hidden);
  return applyHiddenNoindex(response, anyHidden);
};

const handleMultiTicketBySlugs = (request: Request, slugs: string[]): Promise<Response> =>
  withActiveMultiEvents(slugs, (activeEvents) =>
    handleMultiTicket(request, slugs, activeEvents, getMultiTicketContext));

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

/** Context provider for group pages (terms override + shared dates) */
const getGroupMultiTicketContext = (group: Group): MultiTicketContextProvider =>
  async (events) => {
    const dates = await computeSharedDates(events);
    const globalTerms = await getTermsAndConditionsFromDb();
    const terms = group.terms_and_conditions || globalTerms || "";
    return { dates: dates ?? [], terms };
  };

/** Load group by slug and its active events, return 404 if empty */
const withActiveGroupEventsBySlug = async (
  slug: string,
  handler: AsyncHandler<[Group, MultiTicketEvent[]]>,
): Promise<Response> => {
  const slugIndex = await computeGroupSlugIndex(slug);
  const group = await getGroupBySlugIndex(slugIndex);
  if (!group) return notFoundResponse();

  const [events, holidays] = await Promise.all([getActiveEventsByGroupId(group.id), getActiveHolidays()]);
  const activeEvents = getActiveMultiEvents(sortEvents(events, holidays));
  return activeEvents.length === 0 ? notFoundResponse() : handler(group, activeEvents);
};

const handleGroupTicketBySlug = (request: Request, slug: string): Promise<Response> =>
  withActiveGroupEventsBySlug(slug, (group, activeEvents) =>
    handleMultiTicket(request, [slug], activeEvents, getGroupMultiTicketContext(group)));

/** Handle GET /ticket/reserved - reservation success page */
const handleReservedGet = (request: Request): Response => {
  const url = new URL(request.url);
  const tokensParam = url.searchParams.get("tokens");
  const normalizedTokens = tokensParam?.replaceAll(" ", "+") ?? "";
  const tokens = normalizedTokens.split("+").filter((t) => t.length > 0);
  const ticketUrl = tokens.length > 0 ? `/t/${tokens.join("+")}` : null;
  const inIframe = isIframeRequest(request.url);
  return htmlResponse(reservationSuccessPage(ticketUrl, inIframe));
};

/** Create a slug route that dispatches single vs multi-ticket requests */
const slugRoute = (
  onSingle: (request: Request, slug: string) => Promise<Response>,
  onMulti: (request: Request, slugs: string[]) => Promise<Response>,
) => (request: Request, { slug }: { slug: string }): Promise<Response> =>
  isMultiSlug(slug)
    ? onMulti(request, parseMultiSlugs(slug))
    : onSingle(request, slug);

/** Wrap a single-slug handler with group fallback on 404 */
const withGroupFallback = (
  fn: (request: Request, slug: string) => Promise<Response>,
) => async (request: Request, slug: string): Promise<Response> => {
  const response = await fn(request, slug);
  return response.status === 404 ? handleGroupTicketBySlug(request, slug) : response;
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

/** Handle GET /ticket/:slug/qr */
export const handleTicketQrGet = async (
  _request: Request,
  { slug }: { slug: string },
): Promise<Response> => {
  const event = await getEventWithCountBySlug(slug);
  if (!event) return notFoundResponse();

  const ticketUrl = `https://${getAllowedDomain()}/ticket/${slug}`;
  const svg = await generateQrSvg(ticketUrl);
  return new Response(svg, {
    headers: { "content-type": "image/svg+xml" },
  });
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
