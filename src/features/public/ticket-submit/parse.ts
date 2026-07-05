/**
 * Parsing and validation for a submitted booking form: page state, custom
 * prices, QR overrides, question answers, and the per-node quantities each
 * package count or standalone selector resolves to. Everything here reads the
 * form and the resolved page context; nothing prices or persists.
 */

import type { buildBookingTree } from "#shared/booking/build-tree.ts";
import { parseCustomPrice } from "#shared/booking/form.ts";
import {
  aggregateNodeQuantities,
  nodeQuantitiesFor,
} from "#shared/booking/order-lines.ts";
import {
  packageLimitInfo,
  pagePackageBundleLimit,
} from "#shared/booking/package-cap.ts";
import type { PagePackage } from "#shared/booking/page-packages.ts";
import {
  customPriceFieldName,
  packageQuantityFieldName,
  quantityFieldName,
} from "#shared/booking/tree.ts";
import { getOrCreateStringIds } from "#shared/db/questions.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import { verifyQrBookToken } from "#shared/qr-token.ts";
import { parseNonNegativeInt } from "#shared/validation/number.ts";
import {
  type TicketFormValues,
  tryValidateTicketFields,
} from "#templates/fields.ts";
import {
  buildListingAnswerMap,
  buildListingTextAnswerMap,
  getTicketFieldsSetting,
  parseQuantities,
  ticketFormErrorResponse,
} from "../ticket-form.ts";
import {
  REGISTRATION_CLOSED_SUBMIT_MESSAGE,
  type TicketCtx,
} from "../types.ts";

/** Validate page-level form state before deeper parsing. Returns an error
 * message, or null when the form state is acceptable. */
export const validateFormState = (
  form: FormParams,
  ctx: TicketCtx,
): string | null => {
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

/** Parse custom prices for pay-more listings. Returns an error message string
 * on validation failure, or the custom-price map otherwise. */
export const parseCustomPrices = (
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
export const applyQrTokenOverride = async (
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

export type AnswerInfo = {
  activeQuestions: TicketCtx["questions"];
  answerIds: number[];
  textAnswers: import("#shared/db/questions.ts").TextAnswer[];
  selectedListingIds: Set<number>;
};

/** Compute listing-answer map if answers exist */

export const computeListingTextAnswerIdMap = async (
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

export const computeListingAnswerMap = (
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
 * Every posted count is clamped to the same per-package capacity ceiling the
 * page renders ({@link pagePackageBundleLimit}) so a crafted POST can't exceed
 * a member's remaining capacity or book a closed/sold-out member (whose
 * `maxPurchasable` — and thus the cap — is 0). All-zero lines are rejected by
 * `prepareOrder` as "select at least one ticket".
 */
export const resolvePageQuantities = (
  form: FormParams,
  ctx: TicketCtx,
  tree: ReturnType<typeof buildBookingTree>,
): { nodeQuantities: Map<string, number>; quantities: Map<number, number> } => {
  // Listings with a standalone node keep their own quantity_<id> input — every
  // non-member, plus any member the cart also added by its own slug.
  const standaloneIds = new Set(
    tree.nodes
      .filter((node) => node.quantityRule.kind === "BUYER_CHOICE")
      .map((node) => node.listingId),
  );
  const standaloneQuantities = parseQuantities(
    form,
    ctx.listings.filter((info) => standaloneIds.has(info.listing.id)),
  );
  const packageCounts = new Map(
    ctx.packages.map((pkg) => [
      pkg.groupId,
      Math.max(
        0,
        Math.min(
          parsePackageCount(form, pkg.groupId),
          ctxPackageLimit(ctx, tree, pkg),
        ),
      ),
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
