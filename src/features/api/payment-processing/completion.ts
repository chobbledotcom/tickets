import { completePaidBooking } from "#routes/api/payment-processing/completion-booking.ts";
import { completePlaceholderRefund } from "#routes/api/payment-processing/completion-refund.ts";
import type { PaymentResult, PaymentWork } from "#routes/api/webhook-types.ts";

/** Resume whichever encrypted completion plan the atomic payment fence stored. */
export const completeStoredPayment = (
  work: PaymentWork,
): Promise<PaymentResult> => {
  const completion = work.payment.completion;
  if (completion === null) {
    throw new Error(`Payment ${work.payment.id} has no completion plan`);
  }
  return completion.kind === "booking"
    ? completePaidBooking(work)
    : completePlaceholderRefund(work);
};
