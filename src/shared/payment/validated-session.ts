import { ErrorCode, logError } from "#shared/logger.ts";
import { money } from "#shared/payment/money.ts";
import { isResourceId } from "#shared/payment/resource-id.ts";
import { extractSessionMetadata } from "#shared/payment-helpers.ts";
import type {
  SessionMetadata,
  ValidatedPaymentSession,
} from "#shared/payments.ts";

/**
 * Why a provider session was refused at the boundary.
 *
 * `malformed_charge` — a paid or pending charge whose amount or currency
 * cannot be read (a fraction, a negative, a missing currency, a SumUp amount
 * more precise than the currency allows). `refundable` is true when the charge
 * captured money and the provider gave a usable resource id, so the callback
 * can refund it instead of stranding it.
 *
 * `blank_reference` — the provider says the session is paid but gave no
 * resource id, so no refund is possible; the callback acknowledges it.
 */
export type SessionRejection =
  | {
      reason: "malformed_charge";
      paymentReference: string;
      refundable: boolean;
    }
  | { reason: "blank_reference" };

/** Whether a value is a {@link SessionRejection} (provider adapters and the
 *  callback handlers share this guard for the boundary's refusal). */
export const isSessionRejection = (value: unknown): value is SessionRejection =>
  typeof value === "object" && value !== null && "reason" in value;

/** The malformed-charge refusal for a provider session. `paid` says whether
 *  the charge captured money; the rejection is refundable only when the
 *  provider also gave a usable resource id. */
export const malformedChargeRejection = (
  paymentReference: string,
  paid: boolean,
): SessionRejection => ({
  paymentReference,
  reason: "malformed_charge",
  refundable: paid && isResourceId(paymentReference),
});

export type SessionBuild =
  | { ok: true; session: ValidatedPaymentSession }
  | { ok: false; rejection: SessionRejection };

/** Unwrap the boundary's build result into the session or its rejection. */
export const sessionOrRejection = (
  build: SessionBuild,
): ValidatedPaymentSession | SessionRejection =>
  build.ok ? build.session : build.rejection;

/**
 * Assemble the one ValidatedPaymentSession shape every provider adapter
 * returns, validating the charge's money and resource id at this single
 * boundary so every callback reads a well-formed charge. Owns the createdAt
 * rule — the key is left out entirely when the provider gave no usable
 * timestamp — and normalizes the guarded wire metadata into the canonical
 * shape. `metadata` must already have passed hasRequiredSessionMetadata (or
 * come from our own staged checkout row).
 *
 * Refuses a charge whose amount is not a non-negative safe whole number or
 * whose currency is missing or not three letters, and a session the provider
 * says was paid but gave no resource id for. A free session
 * (`no_payment_required`) carries no resource id, so a blank one is allowed
 * only when no money was captured. The charge's currency is carried on the
 * session; a paid charge in a currency other than the site's is refused by the
 * callbacks (it cannot be honored at the signed total) rather than here, so
 * its captured money still reaches the refund path.
 */
export const validatedPaymentSession = (fields: {
  amountTotal: number | null;
  currency: string | null;
  createdAt: string | undefined;
  id: string;
  metadata: SessionMetadata;
  paymentReference: string;
  paymentStatus: ValidatedPaymentSession["paymentStatus"];
}): SessionBuild => {
  const charge = money(fields.amountTotal, fields.currency);
  if (charge === null) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `Session ${fields.id} carries a malformed charge (amount=${fields.amountTotal}, currency=${fields.currency})`,
    });
    return {
      ok: false,
      rejection: malformedChargeRejection(
        fields.paymentReference,
        fields.paymentStatus === "paid",
      ),
    };
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
    return { ok: false, rejection: { reason: "blank_reference" } };
  }
  return {
    ok: true,
    session: {
      amountTotal: charge.amount,
      currency: charge.currency,
      ...(fields.createdAt !== undefined
        ? { createdAt: fields.createdAt }
        : {}),
      id: fields.id,
      metadata: extractSessionMetadata(fields.metadata),
      paymentReference: fields.paymentReference,
      paymentStatus: fields.paymentStatus,
    },
  };
};
