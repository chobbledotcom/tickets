/**
 * Telling somebody when a refund was withheld.
 *
 * Most withheld refunds are ordinary — the money is already back, a refund is
 * on its way, the provider could not be reached — so they stay at debug level.
 * A refusal means the provider's records and our booking disagree, which no
 * retry can settle, so it goes through the classified error fan-out to reach a
 * person. A debug line reaches nobody.
 */

import { admissionReason, type WithheldRefund } from "#payment/admit-refund.ts";
import { ErrorCode, logDebug, logError } from "#shared/logger.ts";
import type { PaymentProviderType } from "#types";

/** Where the refund was withheld, for the report's tags. */
type WithheldContext = {
  attendeeId?: number | undefined;
  listingId?: number | undefined;
  provider: PaymentProviderType;
};

type WithheldLocation = Omit<WithheldContext, "provider">;

type ProviderWithheldRefund = {
  readonly admission: Extract<WithheldRefund, { kind: "read_failed" }>;
  readonly reference: { readonly provider: PaymentProviderType };
};

const paymentAt = (provider: PaymentProviderType): string =>
  `${provider} payment`;

/** Say that no money was sent, as loudly as the reason deserves. Both refund
 *  paths report through here, so a disagreement the owner must resolve reads
 *  the same whichever one found it. */
export const reportWithheldRefund = (
  admission: WithheldRefund,
  { attendeeId, listingId, provider }: WithheldContext,
): void => {
  const detail = `Refund not sent for ${paymentAt(provider)}: ${admissionReason(
    admission,
  )}`;
  const needsOwner =
    admission.kind === "refused" ||
    (admission.kind === "read_failed" &&
      admission.read.status !== "unavailable");
  if (!needsOwner) {
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

/** Report the unreadable result from the shared provider authority. */
export const reportProviderWithheldRefund = <
  Result extends ProviderWithheldRefund,
>(
  result: Result,
  location: WithheldLocation,
): Result => {
  reportWithheldRefund(result.admission, {
    ...location,
    provider: result.reference.provider,
  });
  return result;
};
