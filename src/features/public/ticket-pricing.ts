/**
 * Pricing and quote helpers for a ticket submission.
 *
 * Pure-ish computation shared by the submission pipeline (`ticket-process.ts`)
 * and the `/calculate` quote: it turns a validated cart into a `CheckoutIntent`,
 * prices it through the shared checkout engine, resolves the eligible
 * modifiers, and answers the sold-out / paid-field questions. It never writes
 * to the database — the callers decide whether to charge or save.
 */

import { priceCheckout } from "#shared/checkout-pricing.ts";
import {
  buyerVisits,
  oversubscribedAnswerTiers,
  type ResolveOptions,
  resolveModifiers,
} from "#shared/db/modifier-resolve.ts";
import { getOrCreateStringIds, type TextAnswer } from "#shared/db/questions.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import {
  type TicketFormValues,
  tryValidateTicketFields,
} from "#templates/fields.ts";
import {
  buildListingAnswerMap,
  buildListingTextAnswerMap,
  type extractContact,
  getTicketFieldsSetting,
  ticketFormErrorResponse,
} from "./ticket-form.ts";
import type { buildRegistrationItems } from "./ticket-payment.ts";
import type { TicketCtx } from "./types.ts";

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

export type AnswerInfo = {
  activeQuestions: TicketCtx["questions"];
  answerIds: number[];
  textAnswers: TextAnswer[];
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
export const TICKETS_UNAVAILABLE_MESSAGE =
  "Sorry, some tickets are no longer available";

export type SubmissionPricingParams = Omit<
  CheckoutIntentParams,
  "modifiers"
> & {
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
