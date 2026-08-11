/**
 * Telling somebody when a refund was withheld.
 *
 * Most withheld refunds are ordinary — the money is already back, a refund is
 * on its way, the provider could not be reached — so they stay at debug level.
 * A refusal means the provider's records and our booking disagree, which no
 * retry can settle, so it goes through the classified error fan-out to reach a
 * person. A debug line reaches nobody.
 */

import { ErrorCode, logDebug, logError } from "#shared/logger.ts";
import {
  admissionReason,
  type WithheldRefund,
} from "#shared/payment/admit-refund.ts";

/** Where the refund was withheld, for the report's tags. */
type WithheldContext = {
  attendeeId?: number | undefined;
  listingId?: number | undefined;
  paymentReference: string;
};

/** Say that no money was sent, as loudly as the reason deserves. Both refund
 *  paths report through here, so a disagreement the owner must resolve reads
 *  the same whichever one found it. */
export const reportWithheldRefund = (
  admission: WithheldRefund,
  { attendeeId, listingId, paymentReference }: WithheldContext,
): void => {
  const detail = `Refund not sent for ${paymentReference}: ${admissionReason(admission)}`;
  if (admission.kind !== "refused") {
    logDebug("Payment", detail);
    return;
  }
  logError({
    attendeeId,
    code: ErrorCode.PAYMENT_REFUND,
    detail: `${detail}. The provider's records and this booking disagree, so an owner needs to look at it.`,
    listingId,
  });
};
