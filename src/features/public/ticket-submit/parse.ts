/**
 * Parsing and validation for a submitted booking form: page state, custom
 * prices, QR overrides, question answers, and the per-node quantities each
 * package count or standalone selector resolves to. Everything here reads the
 * form and the resolved page context. Nothing here prices or persists.
 */

import type { buildBookingTree } from "#booking/build-tree.ts";
import { bookingError, parseCustomPrice } from "#booking/form.ts";
import {
  packageBundleMembers,
  packageBundleMinError,
} from "#booking/min-refusal.ts";
import { quantityBelowMin } from "#booking/model.ts";
import {
  aggregateNodeQuantities,
  nodeQuantitiesFor,
} from "#booking/order-lines.ts";
import {
  packageLimitInfo,
  pagePackageBundleLimit,
} from "#booking/package-cap.ts";
import type { PagePackage } from "#booking/page-packages.ts";
import {
  customPriceFieldName,
  packageQuantityFieldName,
  quantityFieldName,
  standaloneListingIds,
} from "#booking/tree.ts";
import { getOrCreateStringIds } from "#db/questions/strings.ts";
import { byId } from "#fp";
import {
  type AnswerInfo,
  listingAnswerMaps,
  parseQuantities,
  ticketFormErrorResponse,
} from "#routes/public/ticket-form.ts";
import {
  REGISTRATION_CLOSED_SUBMIT_MESSAGE,
  type TicketCtx,
} from "#routes/public/types.ts";
import type { FormParams } from "#shared/form-data.ts";
import { getTicketFieldsSetting } from "#shared/listing-fields.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import { verifyQrBookToken } from "#shared/qr-token.ts";
import { parseNonNegativeInt } from "#shared/validation/number.ts";
import {
  type TicketFormValues,
  tryValidateTicketFields,
} from "#templates/fields/ticket.ts";
import type { ListingWithCount } from "#types";

/** The page-wide refusal when no listing can take a submission. */
const pageWideRefusal = (ctx: TicketCtx): string | null => {
  if (!ctx.listings.every((e) => e.isSoldOut || e.isClosed)) return null;
  return ctx.listings.every((e) => e.isClosed)
    ? REGISTRATION_CLOSED_SUBMIT_MESSAGE
    : "Sorry, not enough spots available";
};

/** The per-listing refusal for one row's posted quantity, or null. */
const quantityRefusal = (form: FormParams, ctx: TicketCtx): string | null => {
  for (const { listing, isClosed, maxPurchasable } of ctx.listings) {
    const selectedQty =
      parseNonNegativeInt(form.get(quantityFieldName(listing.id)) ?? "0") ?? 0;
    if (isClosed && selectedQty > 0) {
      return REGISTRATION_CLOSED_SUBMIT_MESSAGE;
    }
    // A row the page offers never accepts a count in 1..minimum-1. The select
    // cannot send one, so only a crafted or stale POST carries it. Sold-out
    // rows keep the skip behaviour: their posted quantity is ignored.
    if (
      maxPurchasable > 0 &&
      quantityBelowMin(selectedQty, listing.min_quantity)
    ) {
      return bookingError.minimum(listing.name, listing.min_quantity);
    }
    // A count above the live limit refuses instead of silently booking fewer
    // places than the buyer asked for. The select cannot send one, so only a
    // crafted or stale POST carries it.
    if (maxPurchasable > 0 && selectedQty > maxPurchasable) {
      return bookingError.maximum(listing.name, maxPurchasable);
    }
  }
  return null;
};

/** The package refusal for one posted bundle count, or null. An owner can
 *  raise a member's minimum after the package was saved, so the fold
 *  re-reads the stored fact the same way the webhook does. A count above the
 *  page's bundle limit refuses instead of silently booking fewer bundles.
 *  The limit check needs the page's booking tree. A caller that reads only
 *  the stored minimums can omit it. */
/** One form-state gate: the submitted form, the page context, and the booking
 *  tree the bundle-limit refusal reads. */
type FormStateCheck = (
  form: FormParams,
  ctx: TicketCtx,
  tree?: ReturnType<typeof buildBookingTree>,
) => string | null;

const packageQuantityRefusal: FormStateCheck = (form, ctx, tree) => {
  const listingById = byId(ctx.listings.map((info) => info.listing));
  for (const pkg of ctx.packages) {
    const bundleCount = parsePackageCount(form, pkg.groupId);
    if (tree) {
      const limit = ctxPackageLimit(ctx, tree, pkg);
      if (bundleCount > limit) {
        return bookingError.packageMaximum(pkg.name, limit);
      }
    }
    const fixedByListingId = new Map(
      pkg.memberListingIds.map((id) => [id, pkg.quantities.get(id) ?? 1]),
    );
    // A concealed package's member names must not reach the buyer: the
    // refusal names the package, as every other booking error does.
    const namesById = pkg.hideListings
      ? new Map(
          [...listingById].map(([id, listing]) => [
            id,
            { ...listing, name: pkg.name },
          ]),
        )
      : listingById;
    const error = packageBundleMinError(
      packageBundleMembers(fixedByListingId, namesById),
      bundleCount,
    );
    if (error) return error;
  }
  return null;
};

/** The add-on refusal for one posted count above its ceiling, or null. The
 * number input only hints the ceiling, so a crafted or typoed POST can carry
 * more. Refuse instead of silently ordering fewer units than the buyer asked
 * for. */
const addOnQuantityRefusal = (
  form: FormParams,
  ctx: TicketCtx,
): string | null => {
  for (const addOn of ctx.addOns) {
    const selected =
      parseNonNegativeInt(form.get(`addon_${addOn.id}`) ?? "") ?? 0;
    if (selected > addOn.maxQuantity) {
      return bookingError.addOnMaximum(addOn.name, addOn.maxQuantity);
    }
  }
  return null;
};

/** Validate page-level form state before deeper parsing. Returns an error
 * message, or null when the form state is acceptable. The package bundle-limit
 * refusal reads the page's booking tree. Production callers pass it. Callers
 * that only exercise the row minimums can omit it. */
export const validateFormState: FormStateCheck = (form, ctx, tree) => {
  if (ctx.terms && form.get("agree_terms") !== "1") {
    return "You must agree to the terms and conditions";
  }
  return (
    pageWideRefusal(ctx) ??
    quantityRefusal(form, ctx) ??
    packageQuantityRefusal(form, ctx, tree) ??
    addOnQuantityRefusal(form, ctx)
  );
};

/** Validate contact fields once the final priced checkout says whether it is paid. */
export const validateTicketFields = (
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

/** The page's listings that match the pay-more flag. */
const listingsByPayMore = (
  ctx: TicketCtx,
  canPayMore: boolean,
): ListingWithCount[] =>
  ctx.listings
    .filter(({ listing }) => listing.can_pay_more === canPayMore)
    .map(({ listing }) => listing);

/** Parse custom prices for pay-more listings. Returns an error message string
 * on validation failure, or the custom-price map otherwise. */
export const parseCustomPrices = (
  form: FormParams,
  ctx: TicketCtx,
  quantities: Map<number, number>,
): string | Map<number, number> => {
  const customPrices = new Map<number, number>();
  for (const listing of listingsByPayMore(ctx, true)) {
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
export const applyQrTokenOverride = async (
  form: FormParams,
  ctx: TicketCtx,
  customPrices: Map<number, number>,
): Promise<void> => {
  const token = form.getString("qr_token");
  if (!token || ctx.slugs.length !== 1) return;
  const payload = await verifyQrBookToken(ctx.slugs[0]!, token);
  if (!payload || payload.v < 0) return;
  for (const listing of listingsByPayMore(ctx, false)) {
    customPrices.set(listing.id, payload.v);
  }
};

/** Compute listing-answer map if answers exist */

export const computeListingTextAnswerIdMap = async (
  ctx: TicketCtx,
  info: AnswerInfo,
): Promise<CheckoutIntent["listingTextAnswerIds"]> => {
  if (info.textAnswers.length === 0) return;
  const stringIds = await getOrCreateStringIds(
    info.textAnswers.map((answer) => answer.text),
  );
  return Object.fromEntries(
    Object.entries(
      listingAnswerMaps(info, ctx.questionListingMap).textAnswers,
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

export const computeListingAnswerMap = (
  ctx: TicketCtx,
  info: AnswerInfo,
): Record<string, number[]> | undefined =>
  info.answerIds.length > 0
    ? listingAnswerMaps(info, ctx.questionListingMap).answerIds
    : undefined;

/** The buyer-chosen count for one package (0 when absent/invalid). */
const parsePackageCount = (form: FormParams, groupId: number): number =>
  parseNonNegativeInt(form.getString(packageQuantityFieldName(groupId))) ?? 0;

/** One page package's bundle cap, from the ctx's shared capacity maps. */
const ctxPackageLimit = (
  ctx: TicketCtx,
  tree: ReturnType<typeof buildBookingTree>,
  pkg: PagePackage,
): number =>
  pagePackageBundleLimit(
    tree,
    pkg,
    packageLimitInfo(
      ctx.listings,
      ctx.childrenByParentId,
      ctx.packageGroupRemainingByGroupId,
      ctx.packageMemberGroupIds,
    ),
  );

/**
 * Resolve the page listings' quantities from the form. Listings no package
 * books keep their own `quantity_<id>` inputs. For each package the buyer
 * chooses one `package_quantity_<groupId>` count; each member's booked quantity
 * is its fixed per-package quantity × that count (members have no own inputs).
 * A posted count above the page's bundle limit is refused by
 * `validateFormState` before this runs, so the counts here are already inside
 * the ceiling. All-zero lines are rejected by
 * `prepareOrder` as "select at least one ticket".
 */
export const resolvePageQuantities = (
  form: FormParams,
  ctx: TicketCtx,
  tree: ReturnType<typeof buildBookingTree>,
): { nodeQuantities: Map<string, number>; quantities: Map<number, number> } => {
  // Listings with a standalone node keep their own quantity_<id> input — every
  // non-member, plus any member the cart also added by its own slug.
  const standaloneIds = standaloneListingIds(tree);
  const standaloneQuantities = parseQuantities(
    form,
    ctx.listings.filter((info) => standaloneIds.has(info.listing.id)),
  );
  const packageCounts = new Map(
    ctx.packages.map((pkg) => [
      pkg.groupId,
      parsePackageCount(form, pkg.groupId),
    ]),
  );
  const nodeQuantities = nodeQuantitiesFor(
    tree,
    standaloneQuantities,
    packageCounts,
  );
  return {
    nodeQuantities,
    quantities: aggregateNodeQuantities(tree, nodeQuantities),
  };
};
