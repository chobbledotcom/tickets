/**
 * Everything shared by the booking submit and the /calculate quote: validate
 * the page state and fields, resolve quantities through the booking tree,
 * fold selected children, build the per-path lines (hidden-package names
 * concealed), and run the pre-contact pricing pass. Callers map the returned
 * order (or error message) to their own response shape.
 */

import { sum } from "#fp";
import {
  type AnswerInfo,
  listingsWithQuantity,
  parseAddOnSelections,
  resolvePageDate,
} from "#routes/public/ticket-form.ts";
import {
  ctxToBuildTreeInput,
  foldSelectedChildren,
  resolveDayCount,
} from "#routes/public/ticket-payment.ts";
import type { TicketCtx } from "#routes/public/types.ts";
import { buildBookingTree } from "#shared/booking/build-tree.ts";
import { buildOrderLines } from "#shared/booking/order-lines.ts";
import type { PricedOrder } from "#shared/checkout-pricing.ts";
import type { ChildAllocation } from "#shared/db/attendee-types.ts";
import { answerModifierQuantities } from "#shared/db/modifier-resolve.ts";
import { parseQuestionAnswers } from "#shared/db/questions/parsing.ts";
import type { FormParams } from "#shared/form-data.ts";
import { concealLineNames, ctxStandInNames } from "#shared/package-privacy.ts";
import { validateSiteAssignmentConfig } from "#shared/site-assignment.ts";
import {
  applyQrTokenOverride,
  computeListingAnswerMap,
  parseCustomPrices,
  resolvePageQuantities,
  validateFormState,
} from "./parse.ts";
import { publicReservationAmount } from "./paths.ts";
import {
  priceSubmissionBeforeContact,
  type SubmissionPricingParams,
} from "./pricing.ts";

/** A parsed-and-priced submission, or the message explaining why it could not
 * be priced. `prepareOrder` runs every step shared by the booking submit and
 * the `/calculate` quote: page-state and field validation, item building, and
 * the pre-contact pricing pass. */
export type PrepareResult =
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
export const prepareOrder = async (
  ctx: TicketCtx,
  form: FormParams,
): Promise<PrepareResult> => {
  const stateError = validateFormState(form, ctx);
  if (stateError) return { error: stateError, ok: false };

  const tree = buildBookingTree(ctxToBuildTreeInput(ctx));
  const { nodeQuantities, quantities: pageQuantities } = resolvePageQuantities(
    form,
    ctx,
    tree,
  );
  const totalQuantity = sum(Array.from(pageQuantities.values()));
  if (totalQuantity === 0) {
    return { error: "Please select at least one ticket", ok: false };
  }

  // Resolve the order's date and day-count *before* folding children, so the
  // child bookability filter and inherited durations evaluate against the real
  // values.
  const dateResult = resolvePageDate(ctx.dates, form.getString("date"));
  if (!dateResult.ok) return { error: dateResult.error, ok: false };
  const date = dateResult.date;

  const pageSelected = listingsWithQuantity(ctx.listings, pageQuantities);
  const baseHasCustomisable = pageSelected.some(
    ({ listing }) => listing.customisable_days,
  );
  // A HIDDEN package's day-count errors must name that package, not a
  // concealed member — resolved per listing, since a page can carry several
  // packages with different hide flags.
  const standIns = ctxStandInNames(ctx);
  const dayResult = await resolveDayCount(
    pageSelected,
    form,
    date,
    standIns.byListingId,
  );
  if ("error" in dayResult) return { error: dayResult.error, ok: false };

  // Parse the page listings' pay-more prices, then apply any signed QR override
  // — both scoped to page listings only, never folded children (the override
  // must not reach a child line).
  const customPricesResult = parseCustomPrices(form, ctx, pageQuantities);
  if (typeof customPricesResult === "string") {
    return { error: customPricesResult, ok: false };
  }
  await applyQrTokenOverride(form, ctx, customPricesResult);

  // Fold each in-cart parent's selected child into the order: expand the listing
  // set + quantity/custom-price maps + selected ids, so every per-listing path
  // below sees children as ordinary lines.
  const fold = await foldSelectedChildren(
    ctx,
    form,
    {
      customPrices: customPricesResult,
      date,
      dayCount: dayResult.dayCount,
      hasCustomisable: baseHasCustomisable,
      quantities: pageQuantities,
    },
    tree,
  );
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

  // Build the per-path lines from the tree: one line per booked top-level node
  // (each priced by its own rule — a package member's override is a node facet
  // scoped to that path) plus one line per folded child; then hidden-package
  // names are masked.
  const items = concealLineNames(
    buildOrderLines(
      tree,
      nodeQuantities,
      fold.quantities,
      fold.customPrices,
      dayCount,
    ),
    standIns,
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
export const singleListingThankYouUrl = (ctx: TicketCtx): string | null =>
  ctx.listings.length === 1 && !ctx.packages.some((pkg) => pkg.hideListings)
    ? ctx.listings[0]!.listing.thank_you_url
    : null;
