import { completeStoredPayment } from "#routes/api/payment-processing/completion.ts";
import {
  completePaidBooking,
  promoActivities,
} from "#routes/api/payment-processing/completion-booking.ts";
import { paymentWorkWithCompletion } from "#routes/api/payment-processing/completion-runtime.ts";
import { createAttendeeForSession } from "#routes/api/payment-processing/create.ts";
import { validateAllItems } from "#routes/api/payment-processing/items.ts";
import { businessTime } from "#routes/api/payment-processing/metadata.ts";
import {
  checkoutIntentForSession,
  paidPricingRefund,
} from "#routes/api/payment-processing/pricing.ts";
import { recoverOrRefundUnexpectedCreate } from "#routes/api/payment-processing/recovery.ts";
import {
  deletedListingSpec,
  refundSpec,
} from "#routes/api/payment-processing/refunds.ts";
import {
  datelessGhostBookings,
  placeholderBookings,
  settleBalanceSession,
  specForFailure,
  storeRefundedBooking,
} from "#routes/api/payment-processing/store-refund.ts";
import type {
  PaymentFailureResult,
  PaymentResult,
  PaymentWork,
} from "#routes/api/webhook-types.ts";
import { type PricedOrder, priceCheckout } from "#shared/checkout-pricing.ts";
import { generateTicketToken } from "#shared/crypto/utils.ts";
import { buyerVisits, specsFromRefs } from "#shared/db/modifier-resolve.ts";
import {
  type BookingCompletion,
  bookingCompletion,
} from "#shared/payment-completion.ts";

const completeBooking = async (
  work: PaymentWork,
  attendeeId: number,
  completion: BookingCompletion,
  ticketTokens: string[],
): Promise<PaymentResult> =>
  completePaidBooking(
    paymentWorkWithCompletion(work, attendeeId, completion, ticketTokens),
    undefined,
    "critical",
  );

const validationRefund = (
  work: PaymentWork,
  validation: PaymentFailureResult,
): Promise<PaymentFailureResult> =>
  storeRefundedBooking(
    work,
    datelessGhostBookings(work.intent.items),
    validation.status === 404
      ? deletedListingSpec(work.session)
      : refundSpec("price_changed")(validation.detail ?? validation.error),
  );

/** Fulfil a ready aggregate while retaining its lease and revision fence. */
export const fulfilPayment = async (
  work: PaymentWork,
): Promise<PaymentResult> => {
  const { intent, payment, session } = work;
  if (payment.completionState === "pending") {
    return completeStoredPayment(work);
  }
  if (intent.balanceAttendeeId !== undefined) {
    const completion = bookingCompletion(
      intent,
      {
        flow: "balance",
        listingId: intent.items[0]!.e,
        occurredAt: businessTime(session),
        promos: [],
      },
      [],
    );
    const settled = await settleBalanceSession(work, completion);
    return settled.success
      ? completeBooking(work, settled.attendee.id, completion, [])
      : settled;
  }

  const validated = await validateAllItems(session, intent);
  if (!("items" in validated)) return validationRefund(work, validated);
  const validatedItems = validated.items;
  const visits = await buyerVisits(intent.email, intent.phone);
  const modifierSpecs = await specsFromRefs(intent.modifiers, { visits });
  const pricingIntent = checkoutIntentForSession(
    intent,
    validatedItems,
    modifierSpecs,
  );
  const pricedOrder: PricedOrder = priceCheckout(pricingIntent);
  const codeSpecs = modifierSpecs.filter((spec) => spec.trigger === "code");
  const completionFacts: BookingCompletion["facts"] = {
    flow: "registration",
    listingId: validatedItems[0]!.listing.id,
    occurredAt: businessTime(session),
    promos: promoActivities(codeSpecs, pricedOrder.modifierApplications),
  };

  const placeholders = placeholderBookings(validatedItems, intent);
  const knownRefund = paidPricingRefund(
    validatedItems,
    pricedOrder,
    payment.expected.amount,
  );
  if (knownRefund !== null) {
    return storeRefundedBooking(work, placeholders, knownRefund);
  }

  const ticketToken = generateTicketToken();
  const completion = bookingCompletion(intent, completionFacts, [ticketToken]);
  const honoured = await createAttendeeForSession(
    work,
    intent,
    validatedItems,
    pricingIntent,
    pricedOrder,
    ticketToken,
    completion,
  );
  const complete = (
    attendeeId: number,
    ticketTokens: string[],
  ): Promise<PaymentResult> =>
    completeBooking(work, attendeeId, completion, ticketTokens);
  if (honoured.ok === null) {
    return recoverOrRefundUnexpectedCreate({
      complete,
      error: honoured.error,
      placeholders,
      ticketToken,
      work,
    });
  }
  if (!honoured.ok) {
    return storeRefundedBooking(work, placeholders, specForFailure(honoured));
  }
  return complete(honoured.entries[0]!.attendee.id, [ticketToken]);
};

export const formatPaymentError = (result: PaymentFailureResult): string => {
  if (result.refund?.status === "completed") {
    return `${result.error} Your payment has been automatically refunded.`;
  }
  if (result.refund !== undefined) {
    return `${result.error} Please contact support if your refund does not arrive.`;
  }
  return result.error;
};
