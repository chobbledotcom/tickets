/**
 * Core ticket submission orchestrator
 */

import { sum } from "#fp";
import { applyFlash, withCsrfForm } from "#routes/csrf.ts";
import { errorRedirect, redirectResponse } from "#routes/response.ts";
import { getBaseUrl } from "#routes/url.ts";
import {
  type ModifierApplication,
  priceCheckout,
  type TicketPaymentBreakdown,
  ticketPaymentBreakdown,
} from "#shared/checkout-pricing.ts";
import { isPaymentsEnabled } from "#shared/config.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { getPublicDefaultStatus } from "#shared/db/attendee-statuses.ts";
import { buyerVisits, resolveModifiers } from "#shared/db/modifier-resolve.ts";
import { consumeModifierStockOrRollback } from "#shared/db/modifier-usage.ts";
import {
  answerAmountAllocations,
  answerModifierSpecs,
  answerQuantitiesFromListingAnswers,
  groupListingAnswers,
  parseQuestionAnswers,
  saveAttendeeAnswers,
} from "#shared/db/questions.ts";
import { ATTENDEE_DEMO_FIELDS, applyDemoOverrides } from "#shared/demo.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import { verifyQrBookToken } from "#shared/qr-token.ts";
import { validateSiteAssignmentConfig } from "#shared/site-assignment.ts";
import type { Group, ListingWithCount } from "#shared/types.ts";
import {
  parseNonNegativeInt,
  parsePositiveInt,
} from "#shared/validation/number.ts";
import { logAndNotifyRegistration } from "#shared/webhook.ts";
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
  parseAddOnSelections,
  parseCustomPrice,
  parseQuantities,
  ticketFormErrorResponse,
  ticketResponse,
  validateSubmittedDate,
} from "./ticket-form.ts";
import { buildTicketListingsWithGroupCapacity } from "./ticket-listings.ts";
import {
  buildRegistrationItems,
  checkAvailability,
  createFreeReservation,
  getTicketContext,
  handlePaymentFlow,
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

/** Validate page-level form state before deeper parsing. */
const validateFormState = (
  form: FormParams,
  ctx: TicketCtx,
): Response | null => {
  const errorResponse = ticketFormErrorResponse(ctx);
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
    const selectedQty =
      parseNonNegativeInt(form.get(`quantity_${listing.id}`) ?? "0") ?? 0;
    if (isClosed && selectedQty > 0) {
      return errorResponse(REGISTRATION_CLOSED_SUBMIT_MESSAGE);
    }
  }
  return null;
};

/** Validate contact fields once the final priced checkout says whether it is paid. */
const validateTicketFields = (
  form: FormParams,
  ctx: TicketCtx,
  requiresPayment: boolean,
): Response | TicketFormValues =>
  tryValidateTicketFields(
    form,
    getTicketFieldsSetting(ctx.listings),
    ticketFormErrorResponse(ctx),
    requiresPayment,
  );

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

type PaymentPathParams = Pick<
  PathParams,
  "ctx" | "date" | "dayCount" | "quantities"
> & { intent: CheckoutIntent };

const emptyContact = {
  address: "",
  email: "",
  name: "",
  phone: "",
  special_instructions: "",
};

type CheckoutIntentParams = {
  ctx: TicketCtx;
  date: string | null;
  dayCount: number;
  hasCustomisable: boolean;
  info: AnswerInfo;
  items: ReturnType<typeof buildRegistrationItems>;
  modifiers: CheckoutIntent["modifiers"];
  reservationAmount?: string;
};

const checkoutIntentForSubmission = (
  contact: ReturnType<typeof extractContact>,
  params: CheckoutIntentParams,
): CheckoutIntent => {
  const {
    ctx,
    date,
    dayCount,
    hasCustomisable,
    info,
    items,
    modifiers,
    reservationAmount,
  } = params;
  const listingAnswerIds = computeListingAnswerMap(ctx, info);
  return {
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
    ...(modifiers && modifiers.length > 0 ? { modifiers } : {}),
  };
};

/** Handle the paid registration path */
const handlePaidPath = async (
  request: Request,
  params: PaymentPathParams,
): Promise<Response> => {
  const { ctx, quantities, date, dayCount, intent } = params;
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

/** User-facing message when a chosen add-on or discount sold out during a
 * zero-total completion (no provider in the loop, so it didn't sell out
 * "while completing payment" as the webhook path phrases it). */
const MODIFIER_SOLD_OUT_MESSAGE =
  "An extra you selected sold out while you were checking out. Please try again.";

/**
 * Complete a reservation without a payment provider: create the attendee
 * atomically, consume any resolved modifier stock (rolling the order back on
 * a sold-out race), record answers, then notify and redirect.
 *
 * Used for every cart whose final priced total is zero — a free listing, a
 * paid listing discounted to zero, or a zero-price listing whose modifiers net
 * to zero after pricing — and for every cart when payments are disabled (the
 * existing disabled-is-free behaviour). When payments are enabled, the same
 * pricing engine that decided "no provider needed" also produced the modifiers
 * that this path must persist, so a zero-total order still records modifier
 * usage and respects stock limits.
 */
const handleFreePath = async (
  params: PathParams & {
    modifierUsages: ModifierApplication[];
    paymentBreakdown?: TicketPaymentBreakdown;
  },
): Promise<Response> => {
  const {
    ctx,
    quantities,
    date,
    dayCount,
    contact,
    info,
    modifierUsages,
    paymentBreakdown,
  } = params;
  const result = await createFreeReservation({
    contact,
    date,
    dayCount,
    listings: ctx.listings,
    paidByListingId: paymentBreakdown?.paidByListingId,
    quantities,
    remainingBalance: paymentBreakdown?.remainingBalance,
  });
  if (!result.success) return ticketFormErrorResponse(ctx)(result.error);

  // Persist the exact usage amounts returned by the pricing engine. A
  // stock-limited modifier that sold out between resolution and consumption
  // rolls the new attendee back so the buyer isn't granted a free order they
  // shouldn't have.
  const stockModifierUsages = modifierUsages.filter(
    (usage) => usage.source !== "answer",
  );
  if (stockModifierUsages.length > 0) {
    const attendeeId = result.entries[0]!.attendee.id;
    const consumed = await consumeModifierStockOrRollback(
      attendeeId,
      stockModifierUsages,
    );
    if (!consumed) {
      return ticketFormErrorResponse(ctx)(MODIFIER_SOLD_OUT_MESSAGE);
    }
  }

  // Notify only after stock is committed; a rolled-back order should not
  // trigger a registration notification. The hash before passing on so the
  // renewal lookup uses the same blind index the paid path would carry
  // through Stripe session metadata.
  const siteTokenIndex = ctx.siteToken
    ? await hmacHash(ctx.siteToken)
    : undefined;
  await logAndNotifyRegistration(result.entries, siteTokenIndex);

  if (info.answerIds.length > 0) {
    const listingAnswerMap = buildListingAnswerMap(
      info.activeQuestions,
      info.answerIds,
      ctx.questionListingMap,
      info.selectedListingIds,
    );
    await saveAttendeeAnswers(
      groupListingAnswers(result.entries, listingAnswerMap),
      answerAmountAllocations(modifierUsages),
    );
  }

  if (ctx.listings.length === 1) {
    const thankYouUrl = ctx.listings[0]!.listing.thank_you_url;
    if (thankYouUrl) return redirectResponse(thankYouUrl);
  }
  const token = encodeURIComponent(result.token);
  return redirectResponse(`/ticket/reserved?tokens=${token}`);
};

const parseBookingDate = (
  form: FormParams,
  ctx: TicketCtx,
): Response | string | null => {
  if (ctx.dates.length === 0) return null;
  const date = validateSubmittedDate(form, ctx.dates);
  return date ?? ticketFormErrorResponse(ctx)("Please select a valid date");
};

type SubmissionPricingParams = Omit<CheckoutIntentParams, "modifiers"> & {
  addOns: Map<number, number>;
  promoCode: string;
  quantities: Map<number, number>;
};

const priceSubmission = (
  contact: ReturnType<typeof extractContact>,
  params: SubmissionPricingParams,
  modifiers: CheckoutIntent["modifiers"],
): {
  intent: CheckoutIntent;
  pricedOrder: ReturnType<typeof priceCheckout>;
} => {
  const intent = checkoutIntentForSubmission(contact, {
    ctx: params.ctx,
    date: params.date,
    dayCount: params.dayCount,
    hasCustomisable: params.hasCustomisable,
    info: params.info,
    items: params.items,
    modifiers,
    reservationAmount: params.reservationAmount,
  });
  return { intent, pricedOrder: priceCheckout(intent) };
};

const resolveSubmissionModifiers = async (
  params: SubmissionPricingParams,
  visits = 0,
): Promise<CheckoutIntent["modifiers"]> => {
  const listingAnswerIds = computeListingAnswerMap(params.ctx, params.info);
  const answerQuantities = answerQuantitiesFromListingAnswers(
    listingAnswerIds,
    params.quantities,
  );
  const [resolvedModifiers, answerModifiers] = await Promise.all([
    resolveModifiers(params.items, {
      addOns: params.addOns,
      code: params.promoCode,
      ctx: { visits },
    }),
    answerModifierSpecs(params.info.answerIds, answerQuantities),
  ]);
  return [...resolvedModifiers, ...answerModifiers];
};

const priceSubmissionBeforeContact = async (
  params: SubmissionPricingParams,
): Promise<ReturnType<typeof priceSubmission>> =>
  priceSubmission(
    emptyContact,
    params,
    await resolveSubmissionModifiers(params),
  );

const priceSubmissionWithContact = async (
  contact: ReturnType<typeof extractContact>,
  params: SubmissionPricingParams,
): Promise<ReturnType<typeof priceSubmission>> =>
  priceSubmission(
    contact,
    params,
    await resolveSubmissionModifiers(
      params,
      await buyerVisits(contact.email, contact.phone),
    ),
  );

const validatePaymentUpgrade = (
  form: FormParams,
  ctx: TicketCtx,
  initiallyRequired: boolean,
  finallyRequired: boolean,
): TicketFormValues | Response | null => {
  if (!finallyRequired || initiallyRequired) return null;
  return validateTicketFields(form, ctx, true);
};

/** Process submitted form after CSRF and demo overrides. */
const processSubmission = async (
  request: Request,
  ctx: TicketCtx,
  form: FormParams,
): Promise<Response> => {
  const errorResponse = ticketFormErrorResponse(ctx);

  const formStateError = validateFormState(form, ctx);
  if (formStateError) return formStateError;

  const quantities = parseQuantities(form, ctx.listings);
  const totalQuantity = sum(Array.from(quantities.values()));
  if (totalQuantity === 0) {
    return errorResponse("Please select at least one ticket");
  }

  const selected = listingsWithQuantity(ctx.listings, quantities);
  const selectedListingIds = new Set(quantities.keys());
  const siteAssignmentCheck = await validateSiteAssignmentConfig(selected);
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
    return errorResponse(answersResult.error);
  }

  const date = parseBookingDate(form, ctx);
  if (date instanceof Response) return date;

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

  const addOns = parseAddOnSelections(form, ctx.addOns);
  const promoCode = form.getString("promo_code");
  const paymentsEnabled = isPaymentsEnabled();
  const reservationAmount = await publicReservationAmount();
  const pricingParams = {
    addOns,
    ctx,
    date,
    dayCount,
    hasCustomisable,
    info,
    items,
    promoCode,
    quantities,
    reservationAmount,
  };
  const { pricedOrder } = await priceSubmissionBeforeContact(pricingParams);
  const pricedTotal = pricedOrder.total;
  const requiresPaidFields = pricedTotal > 0;
  const validated = validateTicketFields(form, ctx, requiresPaidFields);
  if (validated instanceof Response) return validated;
  let contact = extractContact(validated);
  let { intent, pricedOrder: finalPricedOrder } =
    await priceSubmissionWithContact(contact, pricingParams);
  const paidUpgradeValidation = validatePaymentUpgrade(
    form,
    ctx,
    requiresPaidFields,
    finalPricedOrder.total > 0,
  );
  if (paidUpgradeValidation instanceof Response) return paidUpgradeValidation;
  if (paidUpgradeValidation) {
    contact = extractContact(paidUpgradeValidation);
    ({ intent, pricedOrder: finalPricedOrder } =
      await priceSubmissionWithContact(contact, pricingParams));
  }

  const finalRequiresPaidFields = finalPricedOrder.total > 0;
  const finalRequiresPayment = paymentsEnabled && finalRequiresPaidFields;

  if (finalRequiresPayment) {
    return handlePaidPath(request, {
      ctx,
      date,
      dayCount,
      intent,
      quantities,
    });
  }
  return handleFreePath({
    contact,
    ctx,
    date,
    dayCount,
    hasCustomisable,
    info,
    modifierUsages: paymentsEnabled
      ? finalPricedOrder.modifierApplications
      : [],
    paymentBreakdown: paymentsEnabled
      ? ticketPaymentBreakdown(intent)
      : undefined,
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
    const qty = parsePositiveInt(params.get(`q_${listing.id}`) ?? "");
    if (qty !== null) {
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
