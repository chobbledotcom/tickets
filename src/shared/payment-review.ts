/**
 * Telling somebody when a refund was withheld.
 *
 * Most withheld refunds are ordinary: the money is already back, or a refund
 * is on its way, or the provider could not be reached this minute. Those are
 * answers, not problems, and they stay at debug level.
 *
 * A refusal is different. It means the provider's records and our booking
 * disagree — a charge partly returned, more charges than the booking knows
 * about, totals that do not add up — and no amount of retrying will settle it,
 * because it needs a person to look. Reporting it through the classified error
 * fan-out puts it in front of that person: the console, the ntfy ping, the
 * admin activity log, and Sentry all carry it. A debug line reaches nobody.
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

/**
 * Say that no money was sent, as loudly as the reason deserves.
 *
 * Both refund paths report through here, so a disagreement the owner has to
 * resolve reads the same and reaches the same places whichever one found it.
 */
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
