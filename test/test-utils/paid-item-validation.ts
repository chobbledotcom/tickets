/** Shared fixture for the paid-item suites: one listing's single-place booking
 *  validated at the webhook with its refund stubbed. */

import type { ValidatedItem } from "#routes/api/payment-processing/package-pricing.ts";
import type { PaymentFailureResult } from "#routes/api/webhook-types.ts";
import {
  bookingIntent,
  paymentSession,
} from "#test/features/api/payment-processing/index/helpers.ts";
import { validateAllItems } from "#test/features/api/payment-processing/items/helpers.ts";
import {
  type StripeRefundStub,
  stubRefundPayment,
} from "#test-utils/webhooks/stripe.ts";

/** What one validation answered: the priced items, or the refusal. */
export type ValidationResult =
  | { items: ValidatedItem[]; ok: true }
  | PaymentFailureResult;

/** Validate one listing's single-place booking of `amount` in the session
 *  `sessionId`, with its refund stubbed under `refundId`. The stub is in force
 *  only while the validation runs, so the caller reads the answer it left. */
export const validateListingBooking = async (
  sessionId: string,
  listingId: number,
  amount: number,
  refundId: string,
): Promise<{ refund: StripeRefundStub; result: ValidationResult }> => {
  const intent = bookingIntent([{ e: listingId, p: amount, q: 1 }]);
  const refund = stubRefundPayment(refundId, amount);
  try {
    const result = await validateAllItems(
      paymentSession(sessionId, amount, intent),
      intent,
    );
    return { refund, result };
  } finally {
    refund.restore();
  }
};
