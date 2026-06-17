/**
 * Core ticket submission orchestrator
 */

import { sum } from "#fp";
import { applyFlash, withCsrfForm } from "#routes/csrf.ts";
import { errorRedirect, redirectResponse } from "#routes/response.ts";
import { getBaseUrl } from "#routes/url.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { getPublicDefaultStatus } from "#shared/db/attendee-statuses.ts";
import { buyerVisits, resolveModifiers } from "#shared/db/modifier-resolve.ts";
import {
  groupListingAnswers,
  parseQuestionAnswers,
  saveAttendeeAnswers,
} from "#shared/db/questions.ts";
import { ATTENDEE_DEMO_FIELDS, applyDemoOverrides } from "#shared/demo.ts";
import type { FormParams } from "#shared/form-data.ts";
import { verifyQrBookToken } from "#shared/qr-token.ts";
import { validateSiteAssignmentConfig } from "#shared/site-assignment.ts";
import {
  type Group,
  isPaidListing,
  type ListingWithCount,
} from "#shared/types.ts";
import {
  type TicketFormValues,
  tryValidateTicketFields,
} from "#templates/fields.ts";
import type {
  BookingPrefill,
  TicketListing,
  TicketPrefill,
} from "#templates/public.tsx";
import {
  buildListingAnswerMap,
  extractContact,
  getTicketFieldsSetting,
  listingsWithQuantity,
  parseCustomPrice,
  parseQuantities,
  ticketFormErrorResponse,
  ticketResponse,
  validateSubmittedDate,
} from "./ticket-form.ts";
import { buildTicketListingsWithGroupCapacity } from "./ticket-listings.ts";
import {
  anyRequiresPayment,
  buildRegistrationItems,
  checkAvailability,
  getTicketContext,
  handlePaymentFlow,
  processFreeReservation,
  resolveDayCount,
  withActiveListings,
} from "./ticket-payment.ts";
import {
  applyHiddenNoindex,
  REGISTRATION_CLOSED_SUBMIT_MESSAGE,
  type TicketContextProvider,
  type TicketCtx,
  type TicketSharedContext,
} from "./types.ts";

/** Validate fields, terms and listing availability. Returns Response on error, or parsed field values. */
const validateFormAndAvailability = (
  form: FormParams,
  ctx: TicketCtx,
): Response | TicketFormValues => {
  const errorResponse = ticketFormErrorResponse(ctx);
  const anyPaid = ctx.listings.some((e) => isPaidListing(e.listing));
  const fieldResult = tryValidateTicketFields(
    form,
    getTicketFieldsSetting(ctx.listings),
    errorResponse,
    anyPaid,
  );
  if (fieldResult instanceof Response) return fieldResult;

  if (ctx.terms && form.get("agree_terms") !== "1") {
    return errorResponse("You must agree to the terms and conditions");
  }

  const allUnavailable = ctx.listings.every((e) => e.isSoldOut || e.isClosed);
  if (allUnavailable) {
    const allClosed = ctx.listings.every((e) => e.isClosed);
    return errorResponse(
      allClosed
        ? REGISTRATION_CLOSED_SUBMIT_MESSAGE
        : "Sorry, not enough spots available",
    );
  }

  for (const { listing, isClosed } of ctx.listings) {
    const selectedQty = Number.parseInt(
      form.get(`quantity_${listing.id}`) || "0",
      10,
    );
    if (isClosed && selectedQty > 0) {
      return errorResponse(REGISTRATION_CLOSED_SUBMIT_MESSAGE);
    }
  }
  return fieldResult;
};

/** Parse custom prices for pay-more listings. Returns Response on validation error. */
const parseCustomPrices = (
  form: FormParams,
  ctx: TicketCtx,
  quantities: Map<number, number>,
): Response | Map<number, number> => {
  const errorResponse = ticketFormErrorResponse(ctx);
  const customPrices = new Map<number, number>();
  for (const { listing } of ctx.listings) {
    if (!listing.can_pay_more) continue;
    const qty = quantities.get(listing.id) ?? 0;
    if (qty <= 0) continue;
    const priceResult = parseCustomPrice(
      form,
      `custom_price_${listing.id}`,
      listing.unit_price,
      listing.max_price,
    );
    if (!priceResult.ok) {
      return errorResponse(`${listing.name}: ${priceResult.error}`);
    }
    customPrices.set(listing.id, priceResult.price);
  }
  return customPrices;
};

/**
 * Apply signed QR-token price overrides to the custom prices map.
 *
 * QR tokens can pre-set a price for a specific listing. For can_pay_more listings
 * the user-submitted custom_price_{id} already populated the map in
 * parseCustomPrices and wins. For fixed-price listings the signed value
 * overrides listing.unit_price so admins can generate one-off bookings at any
 * price. Tokens are re-verified here to prevent tampering of the hidden field.
 */
const applyQrTokenOverride = async (
  form: FormParams,
  ctx: TicketCtx,
  customPrices: Map<number, number>,
): Promise<void> => {
  const token = form.getString("qr_token");
  if (!token || ctx.slugs.length !== 1) return;
  const payload = await verifyQrBookToken(ctx.slugs[0]!, token);
  if (!payload || payload.v < 0) return;
  for (const { listing } of ctx.listings) {
    if (!listing.can_pay_more) customPrices.set(listing.id, payload.v);
  }
};

type AnswerInfo = {
  activeQuestions: TicketCtx["questions"];
  answerIds: number[];
  selectedListingIds: Set<number>;
};

/** Compute listing-answer map if answers exist */
const computeListingAnswerMap = (
  ctx: TicketCtx,
  info: AnswerInfo,
): Record<string, number[]> | undefined =>
  info.answerIds.length > 0
    ? buildListingAnswerMap(
        info.activeQuestions,
        info.answerIds,
        ctx.questionListingMap,
        info.selectedListingIds,
      )
    : undefined;

type PathParams = {
  ctx: TicketCtx;
  quantities: Map<number, number>;
  date: string | null;
  dayCount: number;
  hasCustomisable: boolean;
  contact: ReturnType<typeof extractContact>;
  info: AnswerInfo;
};

/** Handle the paid registration path */
const handlePaidPath = async (
  request: Request,
  params: PathParams & {
    items: ReturnType<typeof buildRegistrationItems>;
    reservationAmount?: string;
  },
): Promise<Response> => {
  const {
    ctx,
    quantities,
    date,
    dayCount,
    hasCustomisable,
    contact,
    items,
    info,
    reservationAmount,
  } = params;
  const available = await checkAvailability(
    ctx.listings,
    quantities,
    date,
    dayCount,
  );
  if (!available) {
    return ticketFormErrorResponse(ctx)(
      "Sorry, some tickets are no longer available",
    );
  }
  const listingAnswerIds = computeListingAnswerMap(ctx, info);
  // Modifiers apply only to full-payment orders for now; reservations (deposits)
  // compose with modifiers in a later step. The visit count for the
  // returning-customer gate is re-derived server-side here (keyless) from the
  // contact details entered on the form, so it can't be claimed by the client.
  const modifiers = reservationAmount
    ? []
    : await resolveModifiers(items, {
        visits: await buyerVisits(contact.email, contact.phone),
      });
  const intent = {
    ...contact,
    date,
    items,
    listingAnswerIds,
    // Carry the chosen span only when a customisable listing is involved, so
    // the webhook re-prices and dates the booking by day count, not the
    // listing's fixed duration.
    ...(hasCustomisable ? { dayCount } : {}),
    ...(ctx.siteToken ? { siteToken: ctx.siteToken } : {}),
    ...(reservationAmount ? { reservationAmount } : {}),
    ...(modifiers.length > 0 ? { modifiers } : {}),
  };
  return handlePaymentFlow(request, intent, ctx);
};

/**
 * The reservation-amount the public-default status charges as a deposit, or
 * undefined when public bookings are paid in full. Drives the deposit pricing
 * on the paid path: items keep their full prices (so the booking fee stays on
 * the full order) and each line is charged only this fraction up front.
 */
const publicReservationAmount = async (): Promise<string | undefined> => {
  const status = await getPublicDefaultStatus();
  return status?.is_reservation && status.reservation_amount
    ? status.reservation_amount
    : undefined;
};

/** Handle the free registration path */
const handleFreePath = async (params: PathParams): Promise<Response> => {
  const { ctx, quantities, date, dayCount, contact, info } = params;
  const result = await processFreeReservation(
    ctx.listings,
    quantities,
    contact,
    date,
    ctx.siteToken,
    dayCount,
  );
  if (!result.success) return ticketFormErrorResponse(ctx)(result.error);

  if (info.answerIds.length > 0) {
    const listingAnswerMap = buildListingAnswerMap(
      info.activeQuestions,
      info.answerIds,
      ctx.questionListingMap,
      info.selectedListingIds,
    );
    await saveAttendeeAnswers(
      groupListingAnswers(result.entries, listingAnswerMap),
    );
  }

  if (ctx.listings.length === 1) {
    const thankYouUrl = ctx.listings[0]!.listing.thank_you_url;
    if (thankYouUrl) return redirectResponse(thankYouUrl);
  }
  const token = encodeURIComponent(result.token);
  return redirectResponse(`/ticket/reserved?tokens=${token}`);
};

/** Process submitted form after CSRF and demo overrides. */
const processSubmission = async (
  request: Request,
  ctx: TicketCtx,
  form: FormParams,
): Promise<Response> => {
  const errorResponse = ticketFormErrorResponse(ctx);

  const validated = validateFormAndAvailability(form, ctx);
  if (validated instanceof Response) return validated;
  const values = validated;

  const quantities = parseQuantities(form, ctx.listings);
  const totalQuantity = sum(Array.from(quantities.values()));
  if (totalQuantity === 0) {
    return errorResponse("Please select at least one ticket");
  }

  const selectedListingIds = new Set(quantities.keys());
  const siteAssignmentCheck = await validateSiteAssignmentConfig(
    listingsWithQuantity(ctx.listings, quantities),
  );
  if (!siteAssignmentCheck.ok) {
    return errorResponse(siteAssignmentCheck.message);
  }

  const activeQuestions = ctx.questions.filter((q) => {
    const listingIds = ctx.questionListingMap.get(q.id);
    return !listingIds || listingIds.some((eid) => selectedListingIds.has(eid));
  });
  const answersResult = parseQuestionAnswers({ optional: false })(
    form,
    activeQuestions,
  );
  if (!answersResult.ok) {
    return ticketFormErrorResponse(ctx)(answersResult.error);
  }

  const contact = extractContact(values);

  let date: string | null = null;
  if (ctx.dates.length > 0) {
    date = validateSubmittedDate(form, ctx.dates);
    if (!date) return errorResponse("Please select a valid date");
  }

  const selected = listingsWithQuantity(ctx.listings, quantities);
  const hasCustomisable = selected.some(
    ({ listing }) => listing.customisable_days,
  );
  const dayResult = await resolveDayCount(selected, form, date);
  if ("error" in dayResult) return errorResponse(dayResult.error);
  const dayCount = dayResult.dayCount;

  const customPricesResult = parseCustomPrices(form, ctx, quantities);
  if (customPricesResult instanceof Response) return customPricesResult;

  await applyQrTokenOverride(form, ctx, customPricesResult);

  const items = buildRegistrationItems(
    ctx.listings,
    quantities,
    customPricesResult,
    dayCount,
  );

  const info: AnswerInfo = {
    activeQuestions,
    answerIds: answersResult.answerIds,
    selectedListingIds,
  };

  if (await anyRequiresPayment(items)) {
    return handlePaidPath(request, {
      contact,
      ctx,
      date,
      dayCount,
      hasCustomisable,
      info,
      items,
      quantities,
      reservationAmount: await publicReservationAmount(),
    });
  }
  return handleFreePath({
    contact,
    ctx,
    date,
    dayCount,
    hasCustomisable,
    info,
    quantities,
  });
};

/** Handle POST for ticket registration */
const submitTicket = (request: Request, ctx: TicketCtx): Promise<Response> =>
  withCsrfForm(
    request,
    // CSRF failures redirect with a flash (the token expired or was tampered
    // with — the page reloads with a fresh token). Field-level validation
    // errors instead re-render inline so the visitor keeps what they entered.
    (message) =>
      errorRedirect(ctx.actionUrl ?? `/ticket/${ctx.slugs.join("+")}`, message),
    (form) => {
      applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS);
      return processSubmission(request, ctx, form);
    },
  );

/**
 * Inputs to the booking-page framework: the listings to offer, a context
 * provider that derives the fields/dates/questions/terms from them, the slugs
 * that form the default `/ticket/<slugs>` action, and an optional per-listing
 * pre-fill. Shared by {@link handleTicket} and its callers so the booking
 * "request" has a single named shape across every scenario.
 */
export type BookingRequest = {
  request: Request;
  /** Slugs forming the default `/ticket/<slugs>` form action. */
  slugs: string[];
  listings: TicketListing[];
  getContext: TicketContextProvider;
  prefill?: TicketCtx["prefill"];
};

/** Build the rendering context: derive the booking context from the listings
 * and mint a fresh CSRF token. */
const buildTicketCtx = async ({
  request,
  slugs,
  listings,
  getContext,
  prefill,
}: BookingRequest): Promise<TicketCtx> => {
  const [sharedCtx] = await Promise.all([
    getContext(listings),
    signCsrfToken(),
  ]);
  return {
    baseUrl: getBaseUrl(request),
    listings,
    slugs,
    ...sharedCtx,
    prefill,
  };
};

/** Handle ticket GET/POST orchestrator: render on GET, submit otherwise. */
export const handleTicket = async (args: BookingRequest): Promise<Response> => {
  const { request, listings } = args;
  const ctx = await buildTicketCtx(args);
  const response =
    request.method === "GET"
      ? ticketResponse(ctx)(applyFlash(request).error)
      : await submitTicket(request, ctx);
  return applyHiddenNoindex(
    response,
    listings.some((e) => e.listing.hidden),
  );
};

/**
 * Build a per-listing quantity pre-fill from `?q_<id>=n` query params. The order
 * page redirects into `/ticket/<slugs>?q_<id>=1…` to land the visitor on the
 * booking page with their chosen items already selected; this generalises that
 * URL-driven pre-fill to any `/ticket/<slugs>` page.
 */
const parseQuantityPrefill = (
  request: Request,
  listings: TicketListing[],
): BookingPrefill | undefined => {
  const params = new URL(request.url).searchParams;
  const map = new Map<number, TicketPrefill>();
  for (const { listing } of listings) {
    const qty = Number.parseInt(params.get(`q_${listing.id}`) ?? "", 10);
    if (Number.isInteger(qty) && qty > 0) {
      map.set(listing.id, { quantity: qty });
    }
  }
  return map.size > 0 ? { listings: map } : undefined;
};

/** Handle ticket page by slugs (multi-listing) */
export const handleTicketBySlugs = (
  request: Request,
  slugs: string[],
): Promise<Response> =>
  withActiveListings(slugs, (listings) =>
    handleTicket({
      getContext: getTicketContext,
      listings,
      prefill: parseQuantityPrefill(request, listings),
      request,
      slugs,
    }),
  );

/**
 * The booking-page framework entrypoint: render a booking page for an arbitrary
 * set of listings, letting {@link getTicketContext} derive the fields, dates,
 * questions and terms from the listings themselves. Every booking scenario
 * funnels through here — single listing, multi-listing, group, and the order
 * page — so they share one rendering and submission path.
 *
 * Caller supplies the listings; `group` flows into getTicketContext, `overrides`
 * win over its result (e.g. renewal's actionUrl/siteToken, or the order page's
 * header + action), and `prefill` pre-selects per-listing quantities (the order
 * cart's selected products).
 */
export const renderTicketFlow =
  (
    request: Request,
    slugs: string[],
    options: {
      group?: Group;
      overrides?: Partial<TicketSharedContext>;
      prefill?: BookingPrefill;
    } = {},
  ) =>
  async (listings: ListingWithCount[]): Promise<Response> => {
    const activeListings = await buildTicketListingsWithGroupCapacity(listings);
    return handleTicket({
      getContext: async (e) => ({
        ...(await getTicketContext(e, options.group)),
        ...options.overrides,
      }),
      listings: activeListings,
      prefill: options.prefill,
      request,
      slugs,
    });
  };
