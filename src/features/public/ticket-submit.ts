/**
 * Core ticket submission orchestrator
 */

import { sum } from "#fp";
import { applyFlash, withCsrfForm } from "#routes/csrf.ts";
import {
  errorRedirect,
  htmlResponse,
  notFoundResponse,
  redirectResponse,
} from "#routes/response.ts";
import { getBaseUrl } from "#routes/url.ts";
import {
  customPriceFieldName,
  PACKAGE_QUANTITY_FIELD,
  quantityFieldName,
} from "#shared/booking/tree.ts";
import { owedOrderForLedger } from "#shared/checkout-ledger.ts";
import {
  type ModifierApplication,
  type PricedOrder,
  priceCheckout,
  type TicketPaymentBreakdown,
  ticketPaymentBreakdown,
} from "#shared/checkout-pricing.ts";
import { isPaymentsEnabled } from "#shared/config.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { formatCurrency } from "#shared/currency.ts";
import { getPublicDefaultStatus } from "#shared/db/attendee-statuses.ts";
import type { ChildAllocation } from "#shared/db/attendee-types.ts";
import {
  getGroupRemainingByListingId,
  getSharedGroupCapacities,
} from "#shared/db/attendees.ts";
import { getGroupIdsByListingIds } from "#shared/db/groups.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import {
  answerModifierQuantities,
  buyerVisits,
  oversubscribedAnswerTiers,
  type ResolveOptions,
  resolveModifiers,
} from "#shared/db/modifier-resolve.ts";
import {
  getOrCreateStringIds,
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
import {
  type BookingPrefill,
  orderSummary,
  orderSummaryMessage,
  packageQuantityCap,
  type TicketListing,
  type TicketPrefill,
} from "#templates/public.tsx";
import {
  applyBookingPageParentSoldOut,
  type ChildCapacityCtx,
} from "./discovery.ts";
import {
  buildListingAnswerMap,
  buildListingTextAnswerMap,
  extractContact,
  getTicketFieldsSetting,
  groupListingAnswerSets,
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
  applyPackageOverrides,
  buildRegistrationItems,
  checkAvailability,
  createFreeReservation,
  dropChildListings,
  foldSelectedChildren,
  getTicketContext,
  handlePaymentFlow,
  hidePackageMemberNames,
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

/** Validate page-level form state before deeper parsing. Returns an error
 * message, or null when the form state is acceptable. */
const validateFormState = (form: FormParams, ctx: TicketCtx): string | null => {
  if (ctx.terms && form.get("agree_terms") !== "1") {
    return "You must agree to the terms and conditions";
  }

  const allUnavailable = ctx.listings.every((e) => e.isSoldOut || e.isClosed);
  if (allUnavailable) {
    const allClosed = ctx.listings.every((e) => e.isClosed);
    return allClosed
      ? REGISTRATION_CLOSED_SUBMIT_MESSAGE
      : "Sorry, not enough spots available";
  }

  for (const { listing, isClosed } of ctx.listings) {
    const selectedQty =
      parseNonNegativeInt(form.get(quantityFieldName(listing.id)) ?? "0") ?? 0;
    if (isClosed && selectedQty > 0) {
      return REGISTRATION_CLOSED_SUBMIT_MESSAGE;
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

/** Parse custom prices for pay-more listings. Returns an error message string
 * on validation failure, or the custom-price map otherwise. */
const parseCustomPrices = (
  form: FormParams,
  ctx: TicketCtx,
  quantities: Map<number, number>,
): string | Map<number, number> => {
  const customPrices = new Map<number, number>();
  for (const { listing } of ctx.listings) {
    if (!listing.can_pay_more) continue;
    const qty = quantities.get(listing.id) ?? 0;
    if (qty <= 0) continue;
    const priceResult = parseCustomPrice(
      form,
      customPriceFieldName(listing.id),
      listing.unit_price,
      listing.max_price,
    );
    if (!priceResult.ok) {
      return `${listing.name}: ${priceResult.error}`;
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
  textAnswers: import("#shared/db/questions.ts").TextAnswer[];
  selectedListingIds: Set<number>;
};

/** Compute listing-answer map if answers exist */

const computeListingTextAnswerIdMap = async (
  ctx: TicketCtx,
  info: AnswerInfo,
): Promise<CheckoutIntent["listingTextAnswerIds"]> => {
  if (info.textAnswers.length === 0) return undefined;
  const stringIds = await getOrCreateStringIds(
    info.textAnswers.map((answer) => answer.text),
  );
  return Object.fromEntries(
    Object.entries(
      buildListingTextAnswerMap(
        info.textAnswers,
        ctx.questionListingMap,
        info.selectedListingIds,
      ),
    ).map(([listingId, answers]) => [
      listingId,
      // These answers are a subset of the texts handed to getOrCreateStringIds,
      // which returns an id for every input text or throws — so `s` is always a
      // real id here, never the undefined that JSON.stringify would silently
      // drop from the signed metadata.
      answers.map((answer) => ({
        q: answer.questionId,
        s: stringIds.get(answer.text)!,
      })),
    ]),
  );
};

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
  "ctx" | "date" | "dayCount" | "quantities" | "info"
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
  reservationAmount?: string | undefined;
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
    ...(ctx.packageGroupId ? { packageGroupId: ctx.packageGroupId } : {}),
  };
};

/** Shown when a cart's tickets sell out between page load and submission. */
const TICKETS_UNAVAILABLE_MESSAGE =
  "Sorry, some tickets are no longer available";

/** Handle the paid registration path */
const handlePaidPath = async (
  request: Request,
  params: PaymentPathParams,
): Promise<Response> => {
  const { ctx, quantities, date, dayCount, info, intent } = params;
  const available = await checkAvailability(
    ctx.listings,
    quantities,
    date,
    dayCount,
  );
  if (!available) {
    return ticketFormErrorResponse(ctx)(TICKETS_UNAVAILABLE_MESSAGE);
  }
  // Create the encrypted free-text strings only once availability is confirmed,
  // so a rejected over-capacity submission never leaves orphaned plaintext rows.
  const listingTextAnswerIds = await computeListingTextAnswerIdMap(ctx, info);
  if (listingTextAnswerIds !== undefined) {
    intent.listingTextAnswerIds = listingTextAnswerIds;
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

/**
 * Complete a reservation without a payment provider: create the attendee
 * atomically, consume any resolved modifier stock (rolling the order back on
 * a sold-out race), record answers, then notify and redirect.
 *
 * Used for every cart whose final priced total is zero — a free listing, a
 * paid listing discounted to zero, or a zero-price listing whose modifiers net
 * to zero after pricing — and for every cart when payments are disabled (the
 * existing disabled-is-free behaviour). Either way the modifiers the pricing
 * engine resolved are persisted here, so a zero-total or disabled-payments
 * order still records modifier usage and consumes stock — keeping a
 * stock-limited answer tier capped across free bookings, not just paid ones.
 */
const handleFreePath = async (
  params: PathParams & {
    modifierUsages: ModifierApplication[];
    paymentBreakdown?: TicketPaymentBreakdown;
    /** Pre-fold single-parent thank-you URL, kept across the fold so a parent +
     * its folded children still redirects to the parent's configured URL. */
    thankYouUrl?: string | null;
    ledgerOrder: PricedOrder | null;
    allocations?: ChildAllocation[];
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
    thankYouUrl,
    ledgerOrder,
    allocations,
  } = params;
  const result = await createFreeReservation({
    allocations,
    contact,
    date,
    dayCount,
    // The caller decides whether this booking dual-writes the ledger: an enabled,
    // zero-total checkout posts the same gross-sale / discount / owed legs a paid
    // one would; a provider-less booking passes null and records nothing here
    // (stock is consumed in the create transaction either way).
    ledgerOrder,
    listings: ctx.listings,
    modifierUsages,
    // Carry the package group id so each booking row stores it (0 = not a
    // package), grouping the order under the package on the ticket view / email.
    ...(ctx.packageGroupId ? { packageGroupId: ctx.packageGroupId } : {}),
    paidByListingId: paymentBreakdown?.paidByListingId,
    quantities,
    remainingBalance: paymentBreakdown?.remainingBalance,
  });
  if (!result.success) return ticketFormErrorResponse(ctx)(result.error);

  // Notify only after stock is committed; a rolled-back order should not
  // trigger a registration notification. The hash before passing on so the
  // renewal lookup uses the same blind index the paid path would carry
  // through Stripe session metadata.
  const siteTokenIndex = ctx.siteToken
    ? await hmacHash(ctx.siteToken)
    : undefined;
  await logAndNotifyRegistration(result.entries, siteTokenIndex);

  if (info.answerIds.length > 0 || info.textAnswers.length > 0) {
    await saveAttendeeAnswers(
      groupListingAnswerSets(
        result.entries,
        buildListingAnswerMap(
          info.activeQuestions,
          info.answerIds,
          ctx.questionListingMap,
          info.selectedListingIds,
        ),
        buildListingTextAnswerMap(
          info.textAnswers,
          ctx.questionListingMap,
          info.selectedListingIds,
        ),
      ),
    );
  }

  // The caller resolves the redirect from the pre-fold listing set (a single
  // listing's — or a single parent + its folded children's — thank-you URL), so
  // folding a child never drops it.
  if (thankYouUrl) return redirectResponse(thankYouUrl);
  const token = encodeURIComponent(result.token);
  return redirectResponse(`/ticket/reserved?tokens=${token}`);
};

type SubmissionPricingParams = Omit<CheckoutIntentParams, "modifiers"> & {
  addOns: Map<number, number>;
  answerQuantities: Map<number, number>;
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

/** The resolve options for this submission at a given visit count, shared by
 * the pricing resolve and the sold-out check so both judge modifier eligibility
 * (scope, minimum subtotal, visit gate) identically. */
const submissionModifierOpts = (
  params: SubmissionPricingParams,
  visits: number,
): ResolveOptions => ({
  addOns: params.addOns,
  answerQuantities: params.answerQuantities,
  code: params.promoCode,
  ctx: { visits },
});

const resolveSubmissionModifiers = (
  params: SubmissionPricingParams,
  visits = 0,
): Promise<CheckoutIntent["modifiers"]> =>
  // Answer-triggered modifiers join the same single resolve pass as automatic,
  // code, and opt-in add-on modifiers — one engine, one eligibility check.
  resolveModifiers(params.items, submissionModifierOpts(params, visits));

const priceSubmissionBeforeContact = async (
  params: SubmissionPricingParams,
): Promise<ReturnType<typeof priceSubmission>> =>
  priceSubmission(
    emptyContact,
    params,
    await resolveSubmissionModifiers(params),
  );

/** Message shown when a selected answer tier has sold out. */
const soldOutTierMessage = (tiers: string[]): string =>
  `Sorry, ${tiers.join(
    ", ",
  )} is no longer available. Please choose a different option.`;

/**
 * An answer is recorded on every ticket that picked it, so a stock-limited
 * answer tier the buyer over-subscribed can't be partially fulfilled. Returns
 * the user-facing rejection message, or null when nothing is sold out. Shared
 * by the submit path (run at the buyer's real visit count) and the quote (run
 * at zero visits, since a quote strips the PII needed to look the count up), so
 * both reject the same selection identically.
 */
const checkSoldOutTiers = async (
  pricingParams: SubmissionPricingParams,
  visits: number,
): Promise<string | null> => {
  const tiers = await oversubscribedAnswerTiers(
    pricingParams.items,
    submissionModifierOpts(pricingParams, visits),
  );
  return tiers.length > 0 ? soldOutTierMessage(tiers) : null;
};

/** Price with the buyer's real visit count, returning that count so the caller
 * can run the sold-out check against the same eligibility this pricing used. */
const priceSubmissionWithContact = async (
  contact: ReturnType<typeof extractContact>,
  params: SubmissionPricingParams,
): Promise<ReturnType<typeof priceSubmission> & { visits: number }> => {
  const visits = await buyerVisits(contact.email, contact.phone);
  return {
    ...priceSubmission(
      contact,
      params,
      await resolveSubmissionModifiers(params, visits),
    ),
    visits,
  };
};

const validatePaymentUpgrade = (
  form: FormParams,
  ctx: TicketCtx,
  initiallyRequired: boolean,
  finallyRequired: boolean,
): TicketFormValues | Response | null => {
  if (!finallyRequired || initiallyRequired) return null;
  return validateTicketFields(form, ctx, true);
};

/** The buyer-chosen number of packages (0 when absent/invalid → an empty order). */
const parsePackageCount = (form: FormParams): number =>
  parseNonNegativeInt(form.getString(PACKAGE_QUANTITY_FIELD)) ?? 0;

/**
 * Resolve the page listings' quantities from the form. For a package group the
 * buyer chooses a single `package_quantity`; each member's booked quantity is
 * its fixed per-package quantity × that count (the per-member `quantity_<id>`
 * inputs are not offered, so they are ignored). The posted count is clamped to
 * the same capacity ceiling the page renders ({@link packageQuantityCap}) so a
 * crafted POST can't exceed a member's remaining capacity or book a
 * closed/sold-out member (whose `maxPurchasable` — and thus the cap — is 0). A
 * resulting count of 0 yields all-zero lines, which `prepareOrder` rejects as
 * "select at least one ticket". Non-package pages parse the per-listing
 * quantities as usual.
 */
const resolvePageQuantities = (
  form: FormParams,
  ctx: TicketCtx,
): Map<number, number> => {
  const { packageGroupId, packageQuantities } = ctx;
  if (packageGroupId == null || !packageQuantities) {
    return parseQuantities(form, ctx.listings);
  }
  const cap = packageQuantityCap(
    ctx.listings,
    packageQuantities,
    ctx.packageGroupRemainingByGroupId,
    ctx.packageMemberGroupIds,
  );
  const packageQty = Math.max(0, Math.min(parsePackageCount(form), cap));
  const quantities = new Map<number, number>();
  for (const [listingId, fixed] of packageQuantities) {
    quantities.set(listingId, fixed * packageQty);
  }
  return quantities;
};

/** A parsed-and-priced submission, or the message explaining why it could not
 * be priced. `prepareOrder` runs every step shared by the booking submit and
 * the `/calculate` quote: page-state and field validation, item building, and
 * the pre-contact pricing pass. */
type PrepareResult =
  | {
      ok: true;
      pricingParams: SubmissionPricingParams;
      pricedOrder: PricedOrder;
      allocations: ChildAllocation[];
    }
  | { ok: false; error: string };

/**
 * Validate and price a submitted booking form up to (but not including) contact
 * details and any database writes. Shared by {@link processSubmission} (which
 * continues on to charge/save) and {@link calculateTicket} (which renders the
 * priced order as a quote). Errors surface as messages so each caller can map
 * them to its own response shape — a flash redirect for submit, inline HTML for
 * the running total.
 */
const prepareOrder = async (
  ctx: TicketCtx,
  form: FormParams,
): Promise<PrepareResult> => {
  const stateError = validateFormState(form, ctx);
  if (stateError) return { error: stateError, ok: false };

  const pageQuantities = resolvePageQuantities(form, ctx);
  const totalQuantity = sum(Array.from(pageQuantities.values()));
  if (totalQuantity === 0) {
    return { error: "Please select at least one ticket", ok: false };
  }

  // Resolve the order's date and day-count *before* folding children, so the
  // child bookability filter and inherited durations evaluate against the real
  // values (parents.md "Server-side validation" step 2).
  let date: string | null = null;
  if (ctx.dates.length > 0) {
    date = validateSubmittedDate(form, ctx.dates);
    if (!date) return { error: "Please select a valid date", ok: false };
  }

  const pageSelected = listingsWithQuantity(ctx.listings, pageQuantities);
  const baseHasCustomisable = pageSelected.some(
    ({ listing }) => listing.customisable_days,
  );
  const dayResult = await resolveDayCount(pageSelected, form, date);
  if ("error" in dayResult) return { error: dayResult.error, ok: false };

  // Parse the page listings' pay-more prices, then apply any signed QR override
  // — both scoped to page listings only, never folded children (the override
  // must not reach a child line; parents.md QR entry point).
  const customPricesResult = parseCustomPrices(form, ctx, pageQuantities);
  if (typeof customPricesResult === "string") {
    return { error: customPricesResult, ok: false };
  }
  await applyQrTokenOverride(form, ctx, customPricesResult);

  // Fold each in-cart parent's selected child into the order: expand the listing
  // set + quantity/custom-price maps + selected ids, so every per-listing path
  // below sees children as ordinary lines (parents.md fold checklist).
  const fold = await foldSelectedChildren(ctx, form, {
    customPrices: customPricesResult,
    date,
    dayCount: dayResult.dayCount,
    hasCustomisable: baseHasCustomisable,
    quantities: pageQuantities,
  });
  if (!fold.ok) return { error: fold.error, ok: false };
  const { hasCustomisable, dayCount, quantities } = fold;
  const selectedListingIds = fold.selectedListingIds;
  // A folded ctx carrying the expanded listing set drives availability, item
  // building, contact fields and free-reservation creation downstream; the
  // questionListingMap already includes child questions (loaded in
  // getTicketContext).
  const foldedCtx: TicketCtx = { ...ctx, listings: fold.listings };

  const selected = listingsWithQuantity(foldedCtx.listings, quantities);
  const siteAssignmentCheck = await validateSiteAssignmentConfig(selected);
  if (!siteAssignmentCheck.ok) {
    return { error: siteAssignmentCheck.message, ok: false };
  }

  const activeQuestions = foldedCtx.questions.filter((q) => {
    const listingIds = foldedCtx.questionListingMap.get(q.id);
    return !listingIds || listingIds.some((eid) => selectedListingIds.has(eid));
  });
  const answersResult = parseQuestionAnswers({ optional: false })(
    form,
    activeQuestions,
  );
  if (!answersResult.ok) return { error: answersResult.error, ok: false };

  // Build items from the folded set, then apply package overrides to the
  // top-level page listings only (folded children keep their own price).
  const pageListingIds = new Set(ctx.listings.map((e) => e.listing.id));
  const items = hidePackageMemberNames(
    applyPackageOverrides(
      buildRegistrationItems(
        foldedCtx.listings,
        quantities,
        fold.customPrices,
        dayCount,
      ),
      ctx.packagePrices,
      pageListingIds,
    ),
    ctx.hidePackageListings === true,
    ctx.groupName,
  );

  const info: AnswerInfo = {
    activeQuestions,
    answerIds: answersResult.answerIds,
    selectedListingIds,
    textAnswers: answersResult.textAnswers,
  };

  const addOns = parseAddOnSelections(form, ctx.addOns);
  const promoCode = form.getString("promo_code");
  const reservationAmount = await publicReservationAmount();

  // Resolve the answer-triggered modifier quantities once (scope-aware); these
  // feed both the pricing resolve and the sold-out check further down.
  const answerQuantities = await answerModifierQuantities(
    computeListingAnswerMap(foldedCtx, info),
    quantities,
  );

  const pricingParams: SubmissionPricingParams = {
    addOns,
    answerQuantities,
    ctx: foldedCtx,
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
  return {
    allocations: fold.allocations,
    ok: true,
    pricedOrder,
    pricingParams,
  };
};

/** The thank-you URL to honour for a submission's post-booking redirect: a
 * genuine single standalone listing's configured URL. A hidden package is never
 * treated as "single listing" here — even with one member, redirecting to that
 * member's thank-you page would reveal the member the package concealed — so it
 * resolves to null and the booking lands on the generic reserved page. (Folding
 * a required child is handled separately: the single page ctx still drives this,
 * so a child fold never drops a single parent's URL.) */
const singleListingThankYouUrl = (ctx: TicketCtx): string | null =>
  ctx.listings.length === 1 && !ctx.hidePackageListings
    ? ctx.listings[0]!.listing.thank_you_url
    : null;

/** Process submitted form after CSRF and demo overrides. */
const processSubmission = async (
  request: Request,
  ctx: TicketCtx,
  form: FormParams,
): Promise<Response> => {
  const errorResponse = ticketFormErrorResponse(ctx);

  const prepared = await prepareOrder(ctx, form);
  if (!prepared.ok) return errorResponse(prepared.error);
  const { pricingParams, pricedOrder } = prepared;
  const { allocations } = prepared;
  const { date, dayCount, hasCustomisable, info, quantities } = pricingParams;
  // The folded ctx carries the page listings plus the selected children, so it
  // drives contact-field requirements, availability, and reservation creation.
  // The original page ctx still determines the thank-you redirect so folding a
  // child doesn't drop a single parent's configured URL (parents.md fold
  // checklist, thank-you item).
  const foldedCtx = pricingParams.ctx;
  const thankYouUrl = singleListingThankYouUrl(ctx);

  const paymentsEnabled = isPaymentsEnabled();
  const requiresPaidFields = pricedOrder.total > 0;
  const validated = validateTicketFields(form, foldedCtx, requiresPaidFields);
  if (validated instanceof Response) return validated;
  let contact = extractContact(validated);
  let {
    intent,
    pricedOrder: finalPricedOrder,
    visits,
  } = await priceSubmissionWithContact(contact, pricingParams);
  const paidUpgradeValidation = validatePaymentUpgrade(
    form,
    foldedCtx,
    requiresPaidFields,
    finalPricedOrder.total > 0,
  );
  if (paidUpgradeValidation instanceof Response) return paidUpgradeValidation;
  if (paidUpgradeValidation) {
    contact = extractContact(paidUpgradeValidation);
    ({
      intent,
      pricedOrder: finalPricedOrder,
      visits,
    } = await priceSubmissionWithContact(contact, pricingParams));
  }

  // Run the sold-out check at the buyer's real visit count (now known), so a
  // tier that wouldn't apply — cart below its minimum, or too few visits — isn't
  // reported sold out.
  const soldOut = await checkSoldOutTiers(pricingParams, visits);
  if (soldOut) return errorResponse(soldOut);

  const finalRequiresPaidFields = finalPricedOrder.total > 0;
  const finalRequiresPayment = paymentsEnabled && finalRequiresPaidFields;

  if (finalRequiresPayment) {
    // Carry a single parent's configured thank-you URL through the paid round-trip.
    // Folding a required child makes the booking multi-listing, so the webhook's
    // single-unique-listing-id derivation would otherwise drop the parent's URL
    // (parents.md fold checklist, thank-you item). Setting it explicitly on the
    // intent lets the success page prefer it over that derivation. Only needed
    // once a child was actually folded (the order gained a listing); a genuine
    // single-listing order still resolves the same URL by the default rule.
    if (thankYouUrl && foldedCtx.listings.length > ctx.listings.length) {
      intent.thankYouUrl = thankYouUrl;
    }
    if (allocations.length > 0) {
      intent.allocations = allocations;
    }
    return handlePaidPath(request, {
      ctx: foldedCtx,
      date,
      dayCount,
      info,
      intent,
      quantities,
    });
  }
  // With no payment provider configured we still accept bookings for paid items.
  // The order is recorded exactly like a zero-deposit reservation: nothing is
  // collected up front and the full value of the booking becomes the amount
  // owed. Forcing reservationAmount to "0" charges every line zero while the
  // remaining balance captures the full order value — regardless of any
  // reservation amount the public-default status configures, since no deposit
  // can be taken without a provider.
  const breakdownIntent: CheckoutIntent = paymentsEnabled
    ? intent
    : { ...intent, reservationAmount: "0" };
  // The ledger order for a provider-less booking is the breakdown order with the
  // booking fee removed up front (`feeSubtotal: 0` — payments-off charges no fee)
  // and then recast as an OWED order: nothing was collected and no fee is booked,
  // so `owedOrderForLedger` drops every extra and zeroes the total. That posts the
  // gross `sale`/owed legs (and any surcharge add-on as its own `modifier` leg)
  // with NO `fee` and NO `payment` leg — the breakdown intent (kept fee-bearing)
  // still drives the displayed remaining balance below.
  const ledgerOrder = paymentsEnabled
    ? finalPricedOrder
    : owedOrderForLedger(priceCheckout({ ...breakdownIntent, feeSubtotal: 0 }));
  return handleFreePath({
    allocations,
    contact,
    ctx: foldedCtx,
    date,
    dayCount,
    hasCustomisable,
    info,
    // Always dual-write the ledger — outstanding balance is projected from it,
    // so an owed booking must record its legs at creation. A paid or enabled
    // zero-total checkout (fully discounted, zero-deposit reservation) posts
    // `finalPricedOrder`; a provider-less booking posts the OWED order built
    // above, whose gross sale legs leave the full value owed with no fee/payment.
    ledgerOrder,
    // Record modifier usage (and consume stock) on every completion, including
    // bookings taken with no payment provider, so a stock-limited answer tier is
    // capped across all bookings — not just the paid ones the webhook would have
    // consumed. The applied amounts are the real per-modifier impact: a
    // provider-less booking owes the full order value (modifiers included), so
    // its modifiers count exactly as a zero-deposit reservation's would.
    modifierUsages: finalPricedOrder.modifierApplications,
    paymentBreakdown: ticketPaymentBreakdown(breakdownIntent),
    quantities,
    thankYouUrl,
  });
};

const withTicketCsrfForm = (
  request: Request,
  onError: (message: string) => Response,
  onForm: (form: FormParams) => Promise<Response>,
): Promise<Response> => withCsrfForm(request, onError, onForm);

/** Handle POST for ticket registration */
const submitTicket = (request: Request, ctx: TicketCtx): Promise<Response> =>
  withTicketCsrfForm(
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
 * Build the running-total fragment for a parsed-and-priced quote, matching what
 * the submit path would actually collect:
 * - a sold-out answer tier is rejected (as submit would), run at zero visits
 *   since a quote strips the PII needed to look the buyer's count up;
 * - with no payment provider configured the booking is taken without charging,
 *   but a paid order still owes its full value (see {@link handleFreePath}), so
 *   the quote surfaces that amount owed rather than implying the order is free.
 *
 * A returning buyer's `min_visits` modifiers are not reflected — that needs the
 * stripped contact details — so the quote is a zero-visits estimate; the submit
 * path reprices with the real count before charging.
 */
const renderQuote = async (
  ctx: TicketCtx,
  form: FormParams,
): Promise<Response> => {
  const prepared = await prepareOrder(ctx, form);
  if (!prepared.ok) return htmlResponse(orderSummaryMessage(prepared.error));
  const { pricingParams, pricedOrder } = prepared;
  const soldOut = await checkSoldOutTiers(pricingParams, 0);
  if (soldOut) return htmlResponse(orderSummaryMessage(soldOut));
  // Reject a cart that has exhausted capacity (e.g. a dated daily listing whose
  // capped group is full for the chosen day), as the booking submit would. The
  // folded ctx (page listings ∪ selected children) drives the check so a quote
  // reflects the children's capacity too.
  const available = await checkAvailability(
    pricingParams.ctx.listings,
    pricingParams.quantities,
    pricingParams.date,
    pricingParams.dayCount,
  );
  if (!available) {
    return htmlResponse(orderSummaryMessage(TICKETS_UNAVAILABLE_MESSAGE));
  }
  if (isPaymentsEnabled()) {
    return htmlResponse(
      orderSummary(pricedOrder, Boolean(pricingParams.reservationAmount)),
    );
  }
  // No payment provider: the booking is taken without charging, but a paid order
  // still records its full value as the amount owed (see processSubmission), so
  // surface that figure instead of implying the order is free. fullSubtotal is
  // the order value before any deposit split or booking fee — exactly what the
  // submit path stores as the remaining balance.
  return htmlResponse(
    pricedOrder.fullSubtotal > 0
      ? orderSummaryMessage(
          `No online payment is needed now — you'll owe ${formatCurrency(
            pricedOrder.fullSubtotal,
          )} for this booking.`,
        )
      : orderSummaryMessage("No payment required for this booking."),
  );
};

/**
 * Handle POST for the `/calculate` running total. Runs the same parse-and-price
 * path as a real submission but stops before contact validation or any database
 * write, returning the priced order as an HTML fragment. PII fields are never
 * read here — a quote prices the cart with an empty contact — so the client
 * strips them before sending and the server ignores any that arrive.
 */
const calculateTicket = (request: Request, ctx: TicketCtx): Promise<Response> =>
  withTicketCsrfForm(
    request,
    (message) => htmlResponse(orderSummaryMessage(message), 403),
    (form) => renderQuote(ctx, form),
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
  prefill?: TicketCtx["prefill"] | undefined;
  /** When "calculate", a POST returns a priced quote instead of completing the
   * booking. GET requests still render the page regardless. */
  mode?: "calculate" | undefined;
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

/** The render-only view of the context: a parent whose children are all
 * unavailable is projected to sold-out so the GET page shows it sold out (no
 * Book control) instead of a normal form that would only fail at submit (Codex
 * 914). Bookability uses the combined parent+child group demand (invariant I7),
 * so the children's group-remaining is fetched (date-less, like discovery — the
 * authoritative date-specific check is the fold at submit). The submit/quote
 * paths keep the un-projected `ctx` so the fold's authoritative child rejection
 * still runs with its clear error. */
const renderCtx = async (ctx: TicketCtx): Promise<TicketCtx> => {
  const children = [...ctx.childrenByParentId.values()]
    .flat()
    .map((child) => child.listing);
  const [childCaps, childOwnRemaining, holidays, membership] =
    await Promise.all([
      getSharedGroupCapacities(children),
      getGroupRemainingByListingId(children),
      getActiveHolidays(),
      getGroupIdsByListingIds([
        ...ctx.listings.map((l) => l.listing.id),
        ...children.map((c) => c.id),
      ]),
    ]);
  const caps: ChildCapacityCtx = {
    childOwnRemaining,
    membership,
    remainingByGroupId: childCaps.remaining,
    staticCapByGroupId: childCaps.staticCap,
  };
  return {
    ...ctx,
    // The PER-GROUP remaining drives the per-parent quantity clamp keyed by the
    // SPECIFIC group a parent and child share (Codex #3): a parent sharing a capped
    // group with its child offers only floor(sharedRemaining / 2) orders (invariant
    // I7, Fix 3). Carried on the render ctx so `childCappedMax` sees it; submit/quote
    // keep it unset.
    groupIdsByListingId: membership,
    groupRemainingByGroupId: childCaps.remaining,
    listings: applyBookingPageParentSoldOut(
      ctx.listings,
      ctx.childrenByParentId,
      caps,
      holidays,
    ),
  };
};

/** Handle ticket GET/POST orchestrator: render on GET, quote when in calculate
 * mode, otherwise submit. */
export const handleTicket = async (args: BookingRequest): Promise<Response> => {
  const { request, listings, mode } = args;
  const ctx = await buildTicketCtx(args);
  const response =
    request.method === "GET"
      ? ticketResponse(await renderCtx(ctx))(applyFlash(request).error)
      : mode === "calculate"
        ? await calculateTicket(request, ctx)
        : await submitTicket(request, ctx);
  return applyHiddenNoindex(
    response,
    listings.some((e) => e.listing.hidden) ||
      [...ctx.childrenByParentId.values()].flat().some((c) => c.listing.hidden),
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

/**
 * Handle a booking page by slugs (multi-listing). `mode` selects between
 * completing the booking (the default) and pricing it as a `/calculate`
 * running-total quote; both load the same active listings and share one
 * rendering/submission path.
 */
export const handleBySlugs = (
  request: Request,
  slugs: string[],
  mode?: "calculate",
): Promise<Response> =>
  withActiveListings(slugs, (listings) =>
    handleTicket({
      getContext: getTicketContext,
      listings,
      mode,
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
 * cart's selected products). `mode` carries through to {@link handleTicket} so a
 * group quote prices via the same flow as a group booking.
 */
export const renderTicketFlow =
  (
    request: Request,
    slugs: string[],
    options: {
      group?: Group;
      overrides?: Partial<TicketSharedContext>;
      prefill?: BookingPrefill;
      mode?: "calculate";
    } = {},
  ) =>
  async (listings: ListingWithCount[]): Promise<Response> => {
    // Indirect entry points (group/order pages, renewals) load their listings
    // from membership / a saved cart rather than explicit URL slugs, so a child
    // member would otherwise render as a standalone, selectable quantity row a
    // buyer could book alone — bypassing the slug guard, which only rejects
    // DIRECT child slugs. Drop children here so they never appear as standalone
    // rows; their parents stay and re-fold them via `childrenByParentId`
    // (Fix 3, parents.md "strip child rows from indirect pages").
    const withoutChildren = await dropChildListings(listings);
    // When dropping children leaves nothing, every member was a child — a booking
    // can never start from a child (invariant I3), so the page has nothing
    // standalone-bookable. Render 404 rather than a 200 empty booking page (Fix 6,
    // parents.md "indirect page with only children must 404"). Every production
    // caller (group/order/renewal) already hands a non-empty set, so this fires
    // exactly for the all-children case.
    if (withoutChildren.length === 0) return notFoundResponse();
    const activeListings =
      await buildTicketListingsWithGroupCapacity(withoutChildren);
    return handleTicket({
      getContext: async (e) => ({
        ...(await getTicketContext(e, options.group)),
        ...options.overrides,
      }),
      listings: activeListings,
      mode: options.mode,
      prefill: options.prefill,
      request,
      slugs,
    });
  };
