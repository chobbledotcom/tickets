/**
 * Public routes - ticket reservation
 */

import { compact, filter, map, pipe, reduce } from "#fp";
import { getEffectiveDomain, isPaymentsEnabled } from "#lib/config.ts";
import { signCsrfToken } from "#lib/csrf.ts";
import { validatePrice } from "#lib/currency.ts";
import { getAvailableDates } from "#lib/dates.ts";
import {
  checkBatchAvailability,
  createAttendeeAtomic,
} from "#lib/db/attendees.ts";
import {
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
  getQuestionsWithEventIds,
  type QuestionEventMap,
  type QuestionWithAnswers,
  saveAttendeeAnswers,
} from "#lib/db/questions.ts";
import { settings } from "#lib/db/settings.ts";
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
import { loadSortedEvents, sortEvents } from "#lib/sort-events.ts";
import {
  type ContactInfo,
  type EventFields,
  type EventWithCount,
  type Group,
  isPaidEvent,
} from "#lib/types.ts";
import { logAndNotifyRegistration } from "#lib/webhook.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import {
  applyFlash,
  checkoutResponse,
  errorRedirect,
  formatCreationError,
  getBaseUrl,
  htmlResponse,
  isRegistrationClosed,
  notFoundResponse,
  redirectResponse,
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
} from "#templates/public.tsx";

/** Active+visible filter for public event listings */
const isPublicEvent = (e: EventWithCount): boolean => e.active && !e.hidden;

/** Load active events for the homepage, sorted and with registration status */
const loadHomepageEvents = async (): Promise<MultiTicketEvent[]> => {
  const { events } = await loadSortedEvents(isPublicEvent);
  return events.map((e) => buildMultiTicketEvent(e, isRegistrationClosed(e)));
};

/** Guard: redirect to admin login if public site is disabled */
const requirePublicSite = <T>(fn: () => T): T | Response =>
  settings.showPublicSite ? fn() : redirectResponse("/admin/login");

/** Render a public site page with website title and content */
const renderPublicPage = (
  pageType: PublicPageType,
  getContent: () => string | null,
): Response =>
  requirePublicSite(() => {
    const content = getContent();
    return htmlResponse(
      publicSitePage(pageType, settings.websiteTitle, content),
    );
  });

/** Handle GET / (home page) - redirect to admin or show public site */
export const handleHome = (): Response =>
  renderPublicPage("home", () => settings.homepageText);

/** Handle GET /events - public events listing */
export const handlePublicEvents = (): Response | Promise<Response> =>
  requirePublicSite(async () => {
    const events = await loadHomepageEvents();
    return htmlResponse(homepagePage(events, settings.websiteTitle));
  });

/** Handle GET /terms - public terms and conditions page (404 when empty) */
export const handlePublicTerms = (): Response =>
  requirePublicSite(() =>
    settings.terms
      ? htmlResponse(
          publicSitePage("terms", settings.websiteTitle, settings.terms),
        )
      : notFoundResponse(),
  );

/** Handle GET /contact - public contact page (404 when empty) */
export const handlePublicContact = (): Response =>
  requirePublicSite(() =>
    settings.contactPageText
      ? htmlResponse(
          publicSitePage(
            "contact",
            settings.websiteTitle,
            settings.contactPageText,
          ),
        )
      : notFoundResponse(),
  );

/** Set noindex signal header on response for hidden events */
const applyHiddenNoindex = (response: Response, hidden: boolean): Response => {
  if (hidden) response.headers.set("x-robots-noindex", "true");
  return response;
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

/** Parse and validate a custom unit price from a form field.
 * Returns the price in minor units, or an error string if invalid. */
const parseCustomPrice = (
  form: FormParams,
  fieldName: string,
  minPrice: number,
  maxPrice: number,
) => validatePrice(form.getString(fieldName), minPrice, maxPrice);

/** Format error message for failed attendee creation */
const formatAtomicError = (
  reason: "capacity_exceeded" | "encryption_error",
  eventName = "",
): string =>
  formatCreationError(
    "Sorry, not enough spots available",
    (name) => `Sorry, ${name} no longer has enough spots available`,
    "Registration failed. Please try again.",
    reason,
    eventName,
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

/** Build a per-event answer map from parsed answers and the question-event mapping.
 * Each event gets only the answer IDs for questions assigned to it. */
const buildEventAnswerMap = (
  questions: QuestionWithAnswers[],
  answerIds: number[],
  questionEventMap: QuestionEventMap,
  selectedEventIds: Set<number>,
): Record<string, number[]> => {
  const result: Record<string, number[]> = {};
  for (let i = 0; i < questions.length; i++) {
    const question = questions[i]!;
    const answerId = answerIds[i]!;
    // questionEventMap always contains entries for all questions from getQuestionsWithEventIds
    for (const eventId of questionEventMap.get(question.id)!) {
      if (!selectedEventIds.has(eventId)) continue;
      const key = String(eventId);
      (result[key] ??= []).push(answerId);
    }
  }
  return result;
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

/** Parse slugs from a slug string (may contain + separator for multiple events) */
const parseSlugs = (slug: string): string[] =>
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

/** Render ticket HTML (CSRF token auto-embedded by CsrfForm) */
const renderMultiTicketPage = (ctx: MultiTicketCtx, error?: string) =>
  multiTicketPage({ ...ctx, error });

/** Multi-ticket response builder */
const multiTicketResponse =
  (ctx: MultiTicketCtx) =>
  (error?: string, status = 200) =>
    htmlResponse(renderMultiTicketPage(ctx, error), status);

/** Shared rendering context for ticket pages */
type MultiTicketCtx = {
  slugs: string[];
  events: MultiTicketEvent[];
  dates: string[];
  terms: string;
  questions: QuestionWithAnswers[];
  questionEventMap: QuestionEventMap;
  baseUrl?: string;
};

/** Multi-ticket form error redirect (after CSRF passed) */
const multiTicketFormErrorResponse = (ctx: MultiTicketCtx) => {
  const url = `/ticket/${ctx.slugs.join("+")}`;
  return (error: string, _status = 400) => errorRedirect(url, error);
};

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
  questionEventMap: QuestionEventMap;
};

/** Fetch shared context for multi-ticket pages: dates, terms, questions */
const getMultiTicketContext = async (
  activeEvents: MultiTicketEvent[],
): Promise<MultiTicketSharedContext> => {
  const eventIds = activeEvents.map((e) => e.event.id);
  const [dates, terms, questionsResult] = await Promise.all([
    computeSharedDates(activeEvents),
    Promise.resolve(settings.terms),
    getQuestionsWithEventIds(eventIds),
  ]);
  return { dates, terms, ...questionsResult };
};

/** Shared context provider for multi-ticket pages */
type MultiTicketContextProvider = (
  events: MultiTicketEvent[],
) => Promise<MultiTicketSharedContext>;

/** Handle POST for multi-ticket registration */
const submitMultiTicket = (
  request: Request,
  ctx: MultiTicketCtx,
): Promise<Response> =>
  withCsrfForm(
    request,
    (message) => errorRedirect(`/ticket/${ctx.slugs.join("+")}`, message),
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

      // Re-check registration status: events may have closed or sold out
      // since the form was rendered
      const allUnavailable = ctx.events.every((e) => e.isSoldOut || e.isClosed);
      if (allUnavailable) {
        const allClosed = ctx.events.every((e) => e.isClosed);
        return multiTicketFormErrorResponse(ctx)(
          allClosed
            ? REGISTRATION_CLOSED_SUBMIT_MESSAGE
            : "Sorry, not enough spots available",
        );
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

      // Validate custom question answers (only for selected events)
      const selectedEventIds = new Set(quantities.keys());
      const activeQuestions = ctx.questions.filter((q) => {
        const eventIds = ctx.questionEventMap.get(q.id);
        return !eventIds || eventIds.some((eid) => selectedEventIds.has(eid));
      });
      const answersResult = parseQuestionAnswers(form, activeQuestions);
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

        const eventAnswerIds =
          answersResult.answerIds.length > 0
            ? buildEventAnswerMap(
                activeQuestions,
                answersResult.answerIds,
                ctx.questionEventMap,
                selectedEventIds,
              )
            : undefined;
        const intent: MultiRegistrationIntent = {
          ...contact,
          date,
          items,
          eventAnswerIds,
        };
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

      // Save per-event answers for each attendee
      if (answersResult.answerIds.length > 0) {
        const eventAnswerMap = buildEventAnswerMap(
          activeQuestions,
          answersResult.answerIds,
          ctx.questionEventMap,
          selectedEventIds,
        );
        for (const { event, attendee } of result.entries) {
          const answers = eventAnswerMap[String(event.id)];
          if (answers && answers.length > 0) {
            await saveAttendeeAnswers([attendee.id], answers);
          }
        }
      }

      // For single-event bookings, respect the event's custom thank-you URL
      if (ctx.events.length === 1) {
        const thankYouUrl = ctx.events[0]!.event.thank_you_url;
        if (thankYouUrl) return redirectResponse(thankYouUrl);
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
  const [{ dates, terms, questions, questionEventMap }] = await Promise.all([
    getContext(activeEvents),
    signCsrfToken(),
  ]);
  const ctx: MultiTicketCtx = {
    slugs: actionSlugs,
    events: activeEvents,
    dates,
    terms,
    questions,
    questionEventMap,
    baseUrl: getBaseUrl(request),
  };
  if (request.method === "GET") applyFlash(request);
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
const anyRequiresPayment = (items: MultiRegistrationItem[]): boolean => {
  const paymentsEnabled = isPaymentsEnabled();
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
    (msg) => errorRedirect(`/ticket/${ctx.slugs.join("+")}`, msg),
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
  await logAndNotifyRegistration(entries);
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
    const [dates, globalTerms, questionsResult] = await Promise.all([
      computeSharedDates(events),
      Promise.resolve(settings.terms),
      getQuestionsWithEventIds(eventIds),
    ]);
    const terms = group.terms_and_conditions || globalTerms || "";
    return { dates, terms, ...questionsResult };
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

/** Handle ticket request: try events by slugs, fall back to group for single slugs */
const handleTicketBySlug = async (
  request: Request,
  { slug }: { slug: string },
): Promise<Response> => {
  const slugs = parseSlugs(slug);
  const response = await handleMultiTicketBySlugs(request, slugs);
  // For single slugs, fall back to group lookup on 404
  if (response.status === 404 && slugs.length === 1) {
    return handleGroupTicketBySlug(request, slugs[0]!);
  }
  return response;
};

/** Generate a QR code SVG response for a given slug */
const qrResponse = async (slug: string): Promise<Response> => {
  const ticketUrl = `https://${getEffectiveDomain()}/ticket/${slug}`;
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
  "GET /ticket/:slug": handleTicketBySlug,
  "POST /ticket/:slug": handleTicketBySlug,
});

/** Route ticket requests */
export const routeTicket = createRouter(publicRoutes);
