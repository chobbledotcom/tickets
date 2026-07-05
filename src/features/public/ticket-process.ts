/**
 * The ticket submission pipeline: parse and price a submitted booking form,
 * then complete it down either the paid or the provider-less (owed) path.
 *
 * `prepareOrder` runs every step shared by the booking submit and the
 * `/calculate` quote (page-state and field validation, folding children, item
 * building, and the pre-contact pricing pass); `processSubmission` continues on
 * to validate contact details, reprice at the buyer's real visit count, and
 * hand off to the paid or free completion path. Pricing lives in
 * `ticket-pricing.ts`; this module owns the ordering and the database writes.
 */

import { sum } from "#fp";
import { redirectResponse } from "#routes/response.ts";
import { buildBookingTree } from "#shared/booking/build-tree.ts";
import { parseCustomPrice } from "#shared/booking/form.ts";
import {
  packageBundleLimit,
  packageLimitInfo,
} from "#shared/booking/package-cap.ts";
import {
  customPriceFieldName,
  fixedQuantitiesByListingId,
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
import { getPublicDefaultStatus } from "#shared/db/attendee-statuses.ts";
import type { ChildAllocation } from "#shared/db/attendee-types.ts";
import { answerModifierQuantities } from "#shared/db/modifier-resolve.ts";
import {
  parseQuestionAnswers,
  saveAttendeeAnswers,
} from "#shared/db/questions.ts";
import type { FormParams } from "#shared/form-data.ts";
import {
  concealMemberNames,
  memberStandInName,
  packagePrivacyOfCtx,
} from "#shared/package-privacy.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import { verifyQrBookToken } from "#shared/qr-token.ts";
import { validateSiteAssignmentConfig } from "#shared/site-assignment.ts";
import { parseNonNegativeInt } from "#shared/validation/number.ts";
import { logAndNotifyRegistration } from "#shared/webhook.ts";
import {
  buildListingAnswerMap,
  buildListingTextAnswerMap,
  extractContact,
  groupListingAnswerSets,
  listingsWithQuantity,
  parseAddOnSelections,
  parseQuantities,
  ticketFormErrorResponse,
  validateSubmittedDate,
} from "./ticket-form.ts";
import {
  buildRegistrationItems,
  checkAvailability,
  createFreeReservation,
  ctxToBuildTreeInput,
  foldSelectedChildren,
  handlePaymentFlow,
  resolveDayCount,
} from "./ticket-payment.ts";
import {
  type AnswerInfo,
  checkSoldOutTiers,
  computeListingAnswerMap,
  computeListingTextAnswerIdMap,
  priceSubmissionBeforeContact,
  priceSubmissionWithContact,
  type SubmissionPricingParams,
  TICKETS_UNAVAILABLE_MESSAGE,
  validatePaymentUpgrade,
  validateTicketFields,
} from "./ticket-pricing.ts";
import { REGISTRATION_CLOSED_SUBMIT_MESSAGE, type TicketCtx } from "./types.ts";

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

/** Parse custom prices for pay-more listings. Returns an error message string
 * on validation failure, or the custom-price map otherwise. */
const parseListingCustomPrices = (
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
 * parseListingCustomPrices and wins. For fixed-price listings the signed value
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

/** The buyer-chosen number of packages (0 when absent/invalid → an empty order). */
const parsePackageCount = (form: FormParams): number =>
  parseNonNegativeInt(form.getString(PACKAGE_QUANTITY_FIELD)) ?? 0;

/**
 * Resolve the page listings' quantities from the form. For a package group the
 * buyer chooses a single `package_quantity`; each member's booked quantity is
 * its fixed per-package quantity × that count (the per-member `quantity_<id>`
 * inputs are not offered, so they are ignored). The posted count is clamped to
 * the same capacity ceiling the page renders ({@link packageBundleLimit}) so a
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
  // Clamp the posted count to the same tree-driven ceiling the page renders —
  // packageBundleLimit, including required-child capacity — so a crafted POST
  // can't exceed a member's remaining capacity, a shared pool, or the add-ons'
  // combined capacity.
  const tree = buildBookingTree(ctxToBuildTreeInput(ctx));
  const cap = packageBundleLimit(
    tree,
    packageLimitInfo(
      ctx.listings,
      ctx.childrenByParentId,
      ctx.packageGroupRemainingByGroupId,
      ctx.packageMemberGroupIds,
    ),
  );
  const packageQty = Math.max(0, Math.min(parsePackageCount(form), cap));
  return new Map(
    [...fixedQuantitiesByListingId(tree)].map(([listingId, fixed]) => [
      listingId,
      fixed * packageQty,
    ]),
  );
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
 * continues on to charge/save) and the `/calculate` quote (which renders the
 * priced order). Errors surface as messages so each caller can map them to its
 * own response shape — a flash redirect for submit, inline HTML for the running
 * total.
 */
export const prepareOrder = async (
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
  // values.
  let date: string | null = null;
  if (ctx.dates.length > 0) {
    date = validateSubmittedDate(form, ctx.dates);
    if (!date) return { error: "Please select a valid date", ok: false };
  }

  const pageSelected = listingsWithQuantity(ctx.listings, pageQuantities);
  const baseHasCustomisable = pageSelected.some(
    ({ listing }) => listing.customisable_days,
  );
  // A HIDDEN package's day-count errors must name the package, not a concealed
  // member; `groupName` is always set alongside `hidePackageListings`.
  const dayResult = await resolveDayCount(
    pageSelected,
    form,
    date,
    memberStandInName(packagePrivacyOfCtx(ctx)),
  );
  if ("error" in dayResult) return { error: dayResult.error, ok: false };

  // Parse the page listings' pay-more prices, then apply any signed QR override
  // — both scoped to page listings only, never folded children (the override
  // must not reach a child line).
  const customPricesResult = parseListingCustomPrices(
    form,
    ctx,
    pageQuantities,
  );
  if (typeof customPricesResult === "string") {
    return { error: customPricesResult, ok: false };
  }
  await applyQrTokenOverride(form, ctx, customPricesResult);

  // Fold each in-cart parent's selected child into the order: expand the listing
  // set + quantity/custom-price maps + selected ids, so every per-listing path
  // below sees children as ordinary lines.
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

  // Build items from the folded set; each line is priced by the tree's price rule
  // (a package member's override is a node facet scoped to the member line, so no
  // separate override pass is needed), then hidden-package names are masked.
  const items = concealMemberNames(
    buildRegistrationItems(
      foldedCtx.listings,
      quantities,
      fold.customPrices,
      fold.priceRuleByListingId,
      dayCount,
    ),
    packagePrivacyOfCtx(ctx),
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
export const processSubmission = async (
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
  // child doesn't drop a single parent's configured URL.
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
    // single-unique-listing-id derivation would otherwise drop the parent's URL.
    // Setting it explicitly on the
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
