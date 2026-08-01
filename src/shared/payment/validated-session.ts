import { ErrorCode, logError } from "#shared/logger.ts";
import { money } from "#shared/payment/money.ts";
import { isResourceId } from "#shared/payment/resource-id.ts";
import { extractSessionMetadata } from "#shared/payment-helpers.ts";
import type {
  SessionMetadata,
  ValidatedPaymentSession,
} from "#shared/payments.ts";

/**
 * Assemble the one ValidatedPaymentSession shape every provider adapter
 * returns, validating the charge's money and resource id at this single
 * boundary so every callback reads a well-formed charge. Owns the createdAt
 * rule — the key is left out entirely when the provider gave no usable
 * timestamp — and normalizes the guarded wire metadata into the canonical
 * shape. `metadata` must already have passed hasRequiredSessionMetadata (or
 * come from our own staged checkout row).
 *
 * Returns `null` when the charge is malformed: an amount that is not a
 * non-negative safe whole number, a currency that is missing or not three
 * letters, or — for a session the provider says was paid — a blank provider
 * resource id. A free session (`no_payment_required`) carries no resource id,
 * so a blank one is allowed only when no money was captured. The charge's
 * currency is carried on the session; a paid charge in a currency other than
 * the site's is refused by the callbacks (it cannot be honored at the signed
 * total) rather than here, so its captured money still reaches the refund path.
 */
export const validatedPaymentSession = (fields: {
  amountTotal: number | null;
  currency: string | null;
  createdAt: string | undefined;
  id: string;
  metadata: SessionMetadata;
  paymentReference: string;
  paymentStatus: ValidatedPaymentSession["paymentStatus"];
}): ValidatedPaymentSession | null => {
  const charge = money(fields.amountTotal, fields.currency);
  if (charge === null) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `Session ${fields.id} carries a malformed charge (amount=${fields.amountTotal}, currency=${fields.currency})`,
    });
    return null;
  }
  // A paid charge must name the provider resource that captured it. A blank id
  // names no charge to refund — `getRefundPaymentReferences` excludes it and
  // `tryRefund` refuses it — so a paid session with one is refused here rather
  // than persisted as an unrefundable booking. A free session carries none.
  if (
    fields.paymentStatus === "paid" &&
    !isResourceId(fields.paymentReference)
  ) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `Paid session ${fields.id} is missing its provider resource id`,
    });
    return null;
  }
  return {
    amountTotal: charge.amount,
    currency: charge.currency,
    ...(fields.createdAt !== undefined ? { createdAt: fields.createdAt } : {}),
    id: fields.id,
    metadata: extractSessionMetadata(fields.metadata),
    paymentReference: fields.paymentReference,
    paymentStatus: fields.paymentStatus,
  };
};
