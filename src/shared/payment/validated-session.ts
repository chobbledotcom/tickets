import { settings } from "#shared/db/settings.ts";
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
 * letters or does not match the site's one currency, or — for a session the
 * provider says was paid — a blank provider resource id. A free session
 * (`no_payment_required`) carries no resource id, so a blank one is allowed only
 * when no money was captured.
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
  // A site has one currency, fixed at setup. A provider charge must name it:
  // a missing currency is not defaulted to the site's (a missing expected field
  // is a hard no), and a different valid currency is refused because the amount
  // would be in the wrong unit for the site-currency proof the callback checks.
  const charge = money(fields.amountTotal, fields.currency);
  if (charge === null) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `Session ${fields.id} carries a malformed charge (amount=${fields.amountTotal}, currency=${fields.currency})`,
    });
    return null;
  }
  if (charge.currency !== settings.currency.toUpperCase()) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `Session ${fields.id} charged in ${charge.currency} but site currency is ${settings.currency.toUpperCase()}`,
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
    ...(fields.createdAt !== undefined ? { createdAt: fields.createdAt } : {}),
    id: fields.id,
    metadata: extractSessionMetadata(fields.metadata),
    paymentReference: fields.paymentReference,
    paymentStatus: fields.paymentStatus,
  };
};
