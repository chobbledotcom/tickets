/**
 * Everything shared by the booking submit and the /calculate quote: validate
 * the page state and fields, resolve quantities through the booking tree,
 * fold selected children, build the per-path lines (hidden-package names
 * concealed), and run the pre-contact pricing pass. Callers map the returned
 * order (or error message) to their own response shape.
 */

import { buildBookingTree } from "#booking/build-tree.ts";
import { buildOrderLines } from "#booking/order-lines.ts";
import { isMemberNodeOf } from "#booking/tree.ts";
import type { ChildAllocation } from "#db/attendee-types.ts";
import { answerModifierQuantities } from "#db/modifier-resolve.ts";
import { parseQuestionAnswers } from "#db/questions/parsing.ts";
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
import type { PricedOrder } from "#shared/checkout-pricing.ts";
import { allocatedChildIds } from "#shared/child-parents.ts";
import type { FormParams } from "#shared/form-data.ts";
import {
  concealLineNames,
  ctxStandInNames,
  hasNamedBookingPath,
  packageStandIns,
  standInNameFor,
} from "#shared/package-privacy.ts";
import type { CheckoutItem } from "#shared/payments.ts";
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
  const selectedNodes = tree.nodes.filter(
    (node) => nodeQuantities.get(node.nodeKey)! > 0,
  );
  const selectedPackages = ctx.packages.filter((pkg) =>
    selectedNodes.some(isMemberNodeOf(pkg.groupId)),
  );
  const standIns = ctxStandInNames({ ...ctx, packages: selectedPackages });
  const shownSelectedIds = new Set(
    selectedNodes
      .filter((node) => node.visibility === "SHOWN")
      .map((node) => node.listingId),
  );
  const dayErrorStandIns = new Map(
    [...standIns.byListingId].filter(
      ([listingId]) => !shownSelectedIds.has(listingId),
    ),
  );
  const dayResult = await resolveDayCount(
    pageSelected,
    form,
    date,
    dayErrorStandIns,
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
  // set and the quantity/custom-price maps, so every per-listing path below
  // sees children as ordinary lines.
  const fold = await foldSelectedChildren(
    ctx,
    form,
    {
      customPrices: customPricesResult,
      date,
      dayCount: dayResult.dayCount,
      hasCustomisable: baseHasCustomisable,
      nameFor: standInNameFor(standIns, shownSelectedIds),
      quantities: pageQuantities,
    },
    tree,
  );
  if (!fold.ok) return { error: fold.error, ok: false };
  const { hasCustomisable, dayCount, quantities } = fold;
  // A folded ctx carrying the expanded listing set drives availability, item
  // building, contact fields and free-reservation creation downstream; the
  // questionListingMap already includes child questions (loaded in
  // getTicketContext).
  const foldedCtx: TicketCtx = { ...ctx, listings: fold.listings };

  // Build the per-path lines from the tree: one line per booked top-level node
  // (each priced by its own rule — a package member's override is a node facet
  // scoped to that path) plus one line per folded child; then hidden-package
  // names are masked.
  const allocationsByParent = Map.groupBy(
    fold.allocations,
    (allocation) => allocation.parentId,
  );
  const selectedStandIns = packageStandIns(selectedPackages, (parentId) =>
    (allocationsByParent.get(parentId) ?? []).map(
      (allocation) => allocation.childId,
    ),
  );
  const namedListingIds = new Set([
    ...shownSelectedIds,
    ...allocatedChildIds(fold.allocations, shownSelectedIds),
  ]);
  const items = concealLineNames(
    buildOrderLines(
      tree,
      nodeQuantities,
      fold.quantities,
      fold.customPrices,
      dayCount,
    ),
    selectedStandIns,
    namedListingIds,
  );

  // The order's own lines say which listings this booking is for. Every
  // per-listing step below reads the set from here, so an answer cannot be
  // filed under a listing the order has no line for.
  const selectedListingIds = new Set(items.map((item) => item.listingId));

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

/** Folded children cannot reveal the parent's URL or change the page listing
 * count. */
export const singleListingThankYouUrl = (
  ctx: TicketCtx,
  items: readonly CheckoutItem[],
): string | null =>
  ctx.listings.length === 1 &&
  hasNamedBookingPath(
    new Map(ctx.packages.map((pkg) => [pkg.groupId, pkg])),
    items
      .filter((item) => item.listingId === ctx.listings[0]!.listing.id)
      .map((item) => item.packageGroupId ?? 0),
  )
    ? ctx.listings[0]!.listing.thank_you_url
    : null;
