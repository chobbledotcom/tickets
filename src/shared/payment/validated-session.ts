import { ErrorCode, logError } from "#shared/logger.ts";
import { money } from "#shared/payment/money.ts";
import { isResourceId } from "#shared/payment/resource-id.ts";
import { extractSessionMetadata } from "#shared/payment-helpers.ts";
import type {
  SessionMetadata,
  ValidatedPaymentSession,
} from "#shared/payments.ts";
import { isRecord } from "#shared/types.ts";

/**
 * Why a provider session was refused at the boundary. A `malformed_charge`
 * carries its metadata so the callback can check the price proof before
 * refunding — a session signed by another instance must be left alone. A
 * `blank_reference` names no charge at all, so nothing can be refunded.
 */
export type SessionRejection =
  | {
      reason: "malformed_charge";
      paymentReference: string;
      refundable: boolean;
      metadata: SessionMetadata;
    }
  | { reason: "blank_reference" };

/** Whether a value is a {@link SessionRejection}. Only the exact variants with
 *  their fields count, so no invented shape can steer the payment flow. */
export const isSessionRejection = (
  value: unknown,
): value is SessionRejection => {
  if (!isRecord(value)) return false;
  if (value.reason === "blank_reference") return true;
  return (
    value.reason === "malformed_charge" &&
    typeof value.paymentReference === "string" &&
    typeof value.refundable === "boolean" &&
    typeof value.metadata === "object" &&
    value.metadata !== null
  );
};

/** The malformed-charge refusal, refundable only when money was captured AND
 *  the provider named it. The metadata is unpacked first: Square folds its
 *  small fields into one entry, but the price proof is signed over the
 *  unpacked shape, so a packed record would fail its own ownership check and
 *  no Square charge would ever be refunded. */
export const malformedChargeRejection = (
  paymentReference: string,
  paid: boolean,
  metadata: SessionMetadata,
): SessionRejection => ({
  metadata: extractSessionMetadata(metadata),
  paymentReference,
  reason: "malformed_charge",
  refundable: paid && isResourceId(paymentReference),
});

/**
 * The one place a provider's raw session becomes a ValidatedPaymentSession, so
 * every callback downstream reads a charge that has already been checked.
 *
 * `metadata` must already have passed hasRequiredSessionMetadata, or come from
 * our own staged checkout row. A charge in a currency other than the site's is
 * NOT refused here: it is built, and the callbacks treat it as a price mismatch,
 * which is what carries its captured money to the refund path.
 */
export const validatedPaymentSession = (fields: {
  amountTotal: number | null;
  /** Whatever the provider gave, unchanged: absent, blank, and malformed codes
   *  are all refused here rather than defaulted on the way in. */
  currency: string | null | undefined;
  createdAt: string | undefined;
  id: string;
  metadata: SessionMetadata;
  paymentReference: string;
  paymentStatus: ValidatedPaymentSession["paymentStatus"];
}): ValidatedPaymentSession | SessionRejection => {
  const charge = money(fields.amountTotal, fields.currency);
  if (charge === null) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `Session ${fields.id} carries a malformed charge (amount=${fields.amountTotal}, currency=${fields.currency})`,
    });
    return malformedChargeRejection(
      fields.paymentReference,
      fields.paymentStatus === "paid",
      fields.metadata,
    );
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
    return { reason: "blank_reference" };
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
