/** Submitted-form processing: parse and price the form, then complete the
 * booking or price a quote. */

import { withCsrfForm } from "#routes/csrf.ts";
import {
  extractContact,
  ticketFormErrorResponse,
} from "#routes/public/ticket-form.ts";
import { ticketPageUrl } from "#routes/public/ticket-page-url.ts";
import { checkAvailability } from "#routes/public/ticket-payment.ts";
import type { TicketCtx } from "#routes/public/types.ts";
import { errorRedirect, htmlResponse } from "#routes/response.ts";
import { owedOrderForLedger } from "#shared/checkout-ledger.ts";
import {
  priceCheckout,
  ticketPaymentBreakdown,
} from "#shared/checkout-pricing.ts";
import { isPaymentsEnabled } from "#shared/config.ts";
import { formatCurrency } from "#shared/currency.ts";
import {
  ATTENDEE_DEMO_FIELDS,
  applyDemoOverrides,
} from "#shared/demo/overrides.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import {
  orderSummary,
  orderSummaryMessage,
} from "#templates/public/order-summary.tsx";
import { validateTicketFields } from "./parse.ts";
import {
  handleFreePath,
  handlePaidPath,
  TICKETS_UNAVAILABLE_MESSAGE,
} from "./paths.ts";
import {
  type PrepareResult,
  prepareOrder,
  singleListingThankYouUrl,
} from "./prepare.ts";
import {
  checkSoldOutTiers,
  priceSubmissionWithContact,
  validatePaymentUpgrade,
} from "./pricing.ts";

/** A parsed-and-priced order (the ok branch of {@link prepareOrder}). */
type PreparedOrder = Extract<PrepareResult, { ok: true }>;

type PaidBookingMetadata = {
  allocations: PreparedOrder["allocations"];
  foldedListingCount: number;
  pageListingCount: number;
  thankYouUrl: string | null;
};

/** Add metadata needed after a paid booking returns from the provider. Child
 * allocations always travel with the payment. A single parent's redirect only
 * needs an explicit override when folding added a child listing. */
export const withPaidBookingMetadata = (
  intent: CheckoutIntent,
  {
    allocations,
    foldedListingCount,
    pageListingCount,
    thankYouUrl,
  }: PaidBookingMetadata,
): CheckoutIntent => ({
  ...intent,
  ...(thankYouUrl && foldedListingCount > pageListingCount
    ? { thankYouUrl }
    : {}),
  ...(allocations.length > 0 ? { allocations } : {}),
});

/** Parse-and-price the submitted form, or map its failure message to a response
 *  via `onError` (a flash redirect for submit, an HTML fragment for the quote).
 *  Returns the priced order on success, or the already-formed error Response. */
const preparedOrderOr = async (
  ctx: TicketCtx,
  form: FormParams,
  onError: (message: string) => Response,
): Promise<PreparedOrder | Response> => {
  const prepared = await prepareOrder(ctx, form);
  return prepared.ok ? prepared : onError(prepared.error);
};

/** Process submitted form after CSRF and demo overrides. */
const processSubmission = async (
  request: Request,
  ctx: TicketCtx,
  form: FormParams,
): Promise<Response> => {
  const errorResponse = ticketFormErrorResponse(ctx);

  const prepared = await preparedOrderOr(ctx, form, errorResponse);
  if (prepared instanceof Response) return prepared;
  const { allocations, pricingParams, pricedOrder } = prepared;
  const { date, dayCount, hasCustomisable, info, quantities } = pricingParams;
  // The folded ctx carries the page listings plus the selected children, so it
  // drives contact-field requirements, availability, and reservation creation.
  // The original page ctx still determines the thank-you redirect. A fold
  // keeps every single parent's configured URL.
  const foldedCtx = pricingParams.ctx;
  const thankYouUrl = singleListingThankYouUrl(ctx, pricingParams.items);

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

  // Run the sold-out check at the buyer's real visit count, now known. A tier
  // that does not apply — a cart below its minimum, or too few visits — is not
  // reported sold out.
  const soldOut = await checkSoldOutTiers(pricingParams, visits);
  if (soldOut) return errorResponse(soldOut);

  const finalRequiresPaidFields = finalPricedOrder.total > 0;
  const finalRequiresPayment = paymentsEnabled && finalRequiresPaidFields;

  if (finalRequiresPayment) {
    return handlePaidPath(request, {
      ctx: foldedCtx,
      date,
      dayCount,
      info,
      intent: withPaidBookingMetadata(intent, {
        allocations,
        foldedListingCount: foldedCtx.listings.length,
        pageListingCount: ctx.listings.length,
        thankYouUrl,
      }),
      quantities,
    });
  }
  // With no payment provider configured we still accept bookings for paid items.
  // The order is recorded exactly like a zero-deposit reservation. Nothing is
  // collected up front. The full value of the booking becomes the amount owed.
  // reservationAmount "0" charges every line zero. The remaining balance then
  // captures the full order value. The public-default status configures a
  // reservation amount, but no deposit can be taken without a provider, so the
  // configured value does not apply here.
  const breakdownIntent: CheckoutIntent = paymentsEnabled
    ? intent
    : { ...intent, reservationAmount: "0" };
  // A provider-less booking is recast as an OWED order. Nothing was collected
  // and no fee is booked, so `owedOrderForLedger` drops every extra and zeroes
  // the total. The posts carry the gross `sale`/owed legs. A surcharge add-on
  // posts its own `modifier` leg. No `fee` or `payment` leg appears. The
  // breakdown intent stays fee-bearing and still drives the displayed remaining
  // balance below.
  const ledgerOrder = paymentsEnabled
    ? finalPricedOrder
    : owedOrderForLedger(priceCheckout(breakdownIntent));
  return handleFreePath({
    allocations,
    contact,
    ctx: foldedCtx,
    date,
    dayCount,
    hasCustomisable,
    info,
    items: pricingParams.items,
    // Always dual-write the ledger. The outstanding balance is projected from
    // it, so an owed booking must record its legs at creation. A paid or
    // enabled zero-total checkout posts `finalPricedOrder`. That case is a fully
    // discounted or zero-deposit reservation. A provider-less booking posts the
    // OWED order built above. Its gross sale legs leave the full value owed
    // with no fee or payment leg.
    ledgerOrder,
    // Record modifier usage (and consume stock) on every completion. This
    // includes bookings taken with no payment provider, so a stock-limited
    // answer tier is capped across all bookings. The cap is not limited to the
    // paid bookings that the webhook consumes. The applied amounts are the real
    // per-modifier impact. A provider-less booking owes the full order value,
    // modifiers included, so its modifiers count like a zero-deposit
    // reservation's.
    modifierUsages: finalPricedOrder.modifierApplications,
    paymentBreakdown: ticketPaymentBreakdown(breakdownIntent),
    quantities,
    thankYouUrl,
  });
};

/** A booking-page POST route: check the CSRF token, then hand the submitted
 * form to `handle`. `onCsrfError` shapes the failure response for the route's
 * medium (a redirect for the full submit, an HTML fragment for the quote). */
const ticketFormRoute =
  (
    onCsrfError: (ctx: TicketCtx) => (message: string) => Response,
    handle: (
      request: Request,
      ctx: TicketCtx,
      form: FormParams,
    ) => Promise<Response>,
  ) =>
  (request: Request, ctx: TicketCtx): Promise<Response> =>
    withCsrfForm(request, onCsrfError(ctx), (form) =>
      handle(request, ctx, form),
    );

/** Handle POST for ticket registration */
export const submitTicket = ticketFormRoute(
  // CSRF failures redirect with a flash (the token expired or was tampered
  // with — the page reloads with a fresh token). Field-level validation
  // errors instead re-render inline so the visitor keeps what they entered.
  (ctx) => (message) => errorRedirect(ticketPageUrl(ctx), message),
  (request, ctx, form) => {
    applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS);
    return processSubmission(request, ctx, form);
  },
);

/**
 * A quote strips the PII needed to look up a buyer's visit count, so it runs at
 * zero visits. A returning buyer's `min_visits` modifiers are therefore absent.
 * The submit path reprices with the real count before it charges.
 *
 * With no payment provider the booking is taken without charging. A paid
 * order still owes its full value. The quote surfaces the amount owed and
 * never implies that the order is free.
 */
const renderQuote = async (
  ctx: TicketCtx,
  form: FormParams,
): Promise<Response> => {
  const prepared = await preparedOrderOr(ctx, form, (message) =>
    htmlResponse(orderSummaryMessage(message)),
  );
  if (prepared instanceof Response) return prepared;
  const { pricingParams, pricedOrder } = prepared;
  const soldOut = await checkSoldOutTiers(pricingParams, 0);
  if (soldOut) return htmlResponse(orderSummaryMessage(soldOut));
  // Reject a cart that used up its capacity, as the booking submit does. For
  // example, a dated daily listing whose capped group is full for the chosen
  // day. The folded ctx (page listings ∪ selected children) drives the check,
  // so a quote reflects the children's capacity too.
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
  // No payment provider: the booking is taken without charging. A paid order
  // still records its full value as the amount owed (see processSubmission).
  // Surface that figure instead of implying that the order is free. The
  // `fullSubtotal` field is the order value before any deposit split or booking
  // fee. The submit path stores it as the remaining balance.
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
 * Handle POST for the `/calculate` running total. The route runs the same
 * parse-and-price path as a real submission. It stops before contact
 * validation or any database write and returns the priced order as an HTML
 * fragment. The route never reads PII fields: a quote prices the cart with an
 * empty contact. The client strips them before it sends, and the server
 * ignores any that arrive.
 */
export const calculateTicket = ticketFormRoute(
  () => (message) => htmlResponse(orderSummaryMessage(message), 403),
  (_request, ctx, form) => renderQuote(ctx, form),
);
