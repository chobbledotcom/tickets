/**
 * Core ticket submission orchestrator
 */

import { reduce } from "#fp";
import { applyFlash, withCsrfForm } from "#routes/csrf.ts";
import { errorRedirect, redirectResponse } from "#routes/response.ts";
import { getBaseUrl } from "#routes/url.ts";
import { signCsrfToken } from "#shared/csrf.ts";
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
import type { TicketListing } from "#templates/public.tsx";
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
  contact: ReturnType<typeof extractContact>;
  info: AnswerInfo;
};

/** Handle the paid registration path */
const handlePaidPath = async (
  request: Request,
  params: PathParams & { items: ReturnType<typeof buildRegistrationItems> },
): Promise<Response> => {
  const { ctx, quantities, date, contact, items, info } = params;
  const available = await checkAvailability(ctx.listings, quantities, date);
  if (!available) {
    return ticketFormErrorResponse(ctx)(
      "Sorry, some tickets are no longer available",
    );
  }
  const listingAnswerIds = computeListingAnswerMap(ctx, info);
  const intent = {
    ...contact,
    date,
    items,
    listingAnswerIds,
    ...(ctx.siteToken ? { siteToken: ctx.siteToken } : {}),
  };
  return handlePaymentFlow(request, intent, ctx);
};

/** Handle the free registration path */
const handleFreePath = async (params: PathParams): Promise<Response> => {
  const { ctx, quantities, date, contact, info } = params;
  const result = await processFreeReservation(
    ctx.listings,
    quantities,
    contact,
    date,
    ctx.siteToken,
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
  const totalQuantity = reduce(
    (sum: number, qty: number) => sum + qty,
    0,
  )(Array.from(quantities.values()));
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

  const customPricesResult = parseCustomPrices(form, ctx, quantities);
  if (customPricesResult instanceof Response) return customPricesResult;

  await applyQrTokenOverride(form, ctx, customPricesResult);

  const items = buildRegistrationItems(
    ctx.listings,
    quantities,
    customPricesResult,
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
      info,
      items,
      quantities,
    });
  }
  return handleFreePath({ contact, ctx, date, info, quantities });
};

/** Handle POST for ticket registration */
const submitTicket = (request: Request, ctx: TicketCtx): Promise<Response> =>
  withCsrfForm(
    request,
    (message) =>
      errorRedirect(ctx.actionUrl ?? `/ticket/${ctx.slugs.join("+")}`, message),
    (form) => {
      applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS);
      return processSubmission(request, ctx, form);
    },
  );

/** Handle ticket GET/POST orchestrator */
export const handleTicket = async (
  request: Request,
  actionSlugs: string[],
  activeListings: TicketListing[],
  getContext: TicketContextProvider,
  qrPrefill?: TicketCtx["qrPrefill"],
): Promise<Response> => {
  const [sharedCtx] = await Promise.all([
    getContext(activeListings),
    signCsrfToken(),
  ]);
  const ctx: TicketCtx = {
    baseUrl: getBaseUrl(request),
    listings: activeListings,
    slugs: actionSlugs,
    ...sharedCtx,
    qrPrefill,
  };
  const response =
    request.method === "GET"
      ? ticketResponse(ctx)(applyFlash(request).error)
      : await submitTicket(request, ctx);
  const anyHidden = activeListings.some((e) => e.listing.hidden);
  return applyHiddenNoindex(response, anyHidden);
};

/** Handle ticket page by slugs (multi-listing) */
export const handleTicketBySlugs = (
  request: Request,
  slugs: string[],
): Promise<Response> =>
  withActiveListings(slugs, (activeListings) =>
    handleTicket(request, slugs, activeListings, getTicketContext),
  );

/** Curried: build capacity-aware TicketListings and hand off to handleTicket with
 * shared context. Caller supplies the listings; `group` flows into getTicketContext
 * and `overrides` win over its result (e.g. for renewal's actionUrl/siteToken). */
export const renderTicketFlow =
  (
    request: Request,
    slugs: string[],
    options: { group?: Group; overrides?: Partial<TicketSharedContext> } = {},
  ) =>
  async (listings: ListingWithCount[]): Promise<Response> => {
    const activeListings = await buildTicketListingsWithGroupCapacity(listings);
    return handleTicket(request, slugs, activeListings, async (e) => ({
      ...(await getTicketContext(e, options.group)),
      ...options.overrides,
    }));
  };
