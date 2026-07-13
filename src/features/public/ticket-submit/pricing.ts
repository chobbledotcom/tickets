/**
 * Pricing a submitted order: build the checkout intent, resolve every modifier
 * (automatic, code, add-on, answer) in one pass, and price it — before contact
 * details (for quotes) or with the buyer's real visit count (for the submit).
 * The sold-out answer-tier check shares the same eligibility options so both
 * passes judge modifiers identically.
 */

import { priceCheckout } from "#shared/checkout-pricing.ts";
import {
  buyerVisits,
  oversubscribedAnswerTiers,
  type ResolveOptions,
  resolveModifiers,
} from "#shared/db/modifier-resolve.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { CheckoutIntent, CheckoutItem } from "#shared/payments.ts";
import type { TicketFormValues } from "#templates/fields/ticket.ts";
import type { AnswerInfo, extractContact } from "../ticket-form.ts";
import type { TicketCtx } from "../types.ts";
import { computeListingAnswerMap, validateTicketFields } from "./parse.ts";
export const emptyContact = {
  address: "",
  email: "",
  name: "",
  phone: "",
  special_instructions: "",
};

export type CheckoutIntentParams = {
  ctx: TicketCtx;
  date: string | null;
  dayCount: number;
  hasCustomisable: boolean;
  info: AnswerInfo;
  items: CheckoutItem[];
  modifiers: CheckoutIntent["modifiers"];
  reservationAmount?: string | undefined;
};

export const checkoutIntentForSubmission = (
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

export type SubmissionPricingParams = Omit<
  CheckoutIntentParams,
  "modifiers"
> & {
  addOns: Map<number, number>;
  answerQuantities: Map<number, number>;
  promoCode: string;
  quantities: Map<number, number>;
};

export const priceSubmission = (
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

export const priceSubmissionBeforeContact = async (
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
export const checkSoldOutTiers = async (
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
export const priceSubmissionWithContact = async (
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

export const validatePaymentUpgrade = (
  form: FormParams,
  ctx: TicketCtx,
  initiallyRequired: boolean,
  finallyRequired: boolean,
): TicketFormValues | Response | null => {
  if (!finallyRequired || initiallyRequired) return null;
  return validateTicketFields(form, ctx, true);
};
