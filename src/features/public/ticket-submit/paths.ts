/**
 * The two ways a validated, priced order completes: through the payment
 * provider (paid) or straight to a stored reservation (free / zero-total /
 * payments-disabled). Both take the same parsed order facts; the caller
 * decides which path the priced total demands.
 */

import { redirectResponse } from "#routes/response.ts";
import type {
  ModifierApplication,
  PricedOrder,
  TicketPaymentBreakdown,
} from "#shared/checkout-pricing.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { getPublicDefaultStatus } from "#shared/db/attendee-statuses.ts";
import type { ChildAllocation } from "#shared/db/attendee-types.ts";
import { saveAttendeeAnswers } from "#shared/db/questions/attendee-answers.ts";
import type { CheckoutIntent, CheckoutItem } from "#shared/payments.ts";
import { logAndNotifyRegistration } from "#shared/webhook.ts";
import {
  buildListingAnswerMap,
  buildListingTextAnswerMap,
  type extractContact,
  groupListingAnswerSets,
  ticketFormErrorResponse,
} from "../ticket-form.ts";
import {
  checkAvailability,
  createFreeReservation,
  handlePaymentFlow,
} from "../ticket-payment.ts";
import type { TicketCtx } from "../types.ts";
import { type AnswerInfo, computeListingTextAnswerIdMap } from "./parse.ts";

export type PathParams = {
  ctx: TicketCtx;
  quantities: Map<number, number>;
  date: string | null;
  dayCount: number;
  hasCustomisable: boolean;
  contact: ReturnType<typeof extractContact>;
  info: AnswerInfo;
};

export type PaymentPathParams = Pick<
  PathParams,
  "ctx" | "date" | "dayCount" | "quantities" | "info"
> & { intent: CheckoutIntent };

/** Shown when a cart's tickets sell out between page load and submission. */
export const TICKETS_UNAVAILABLE_MESSAGE =
  "Sorry, some tickets are no longer available";

/** Handle the paid registration path */
export const handlePaidPath = async (
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
export const publicReservationAmount = async (): Promise<
  string | undefined
> => {
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
export const handleFreePath = async (
  params: PathParams & {
    items: CheckoutItem[];
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
    items,
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
    // One booking row per checkout line — a listing booked through two paths
    // (overlapping packages, or a package plus standalone) keeps one row per
    // path, each carrying its own package id and charged amount.
    items,
    // The caller decides whether this booking dual-writes the ledger: an enabled,
    // zero-total checkout posts the same gross-sale / discount / owed legs a paid
    // one would; a provider-less booking passes null and records nothing here
    // (stock is consumed in the create transaction either way).
    ledgerOrder,
    listings: ctx.listings,
    modifierUsages,
    paidByItem: paymentBreakdown?.paidByItem,
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
