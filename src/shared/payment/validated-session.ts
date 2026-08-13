import { ErrorCode, logError } from "#shared/logger.ts";
import { money } from "#shared/payment/money.ts";
import type { TaggedPaymentReference } from "#shared/payment/provider-reference.ts";
import { isResourceId } from "#shared/payment/resource-id.ts";
import { extractSessionMetadata } from "#shared/payment-helpers.ts";
import type {
  PaymentProviderType,
  SessionMetadata,
  ValidatedPaymentSession,
} from "#shared/payments.ts";
import { isPaymentProvider, isRecord } from "#shared/types.ts";

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
    provider: PaymentProviderType;
    refundable: boolean;
    metadata: SessionMetadata;
    sessionId: string;
  }
  | {
    provider: PaymentProviderType;
    reason: "blank_reference";
    sessionId: string;
  };

/** The durable charge identity proved by a validated session, or no charge for
 * a free checkout. A non-empty invalid id contradicts the session boundary and
 * fails where it is turned into storage/provider input. */
export const paymentReferenceOf = (
  session: Pick<
    ValidatedPaymentSession,
    "id" | "paymentReference" | "provider"
  >,
): TaggedPaymentReference | null => {
  if (session.paymentReference === "") return null;
  if (!isResourceId(session.paymentReference)) {
    throw new Error("Validated session has an invalid provider resource id");
  }
  return {
    kind: "tagged",
    provider: session.provider,
    reference: session.paymentReference,
  };
};

/** A session path that requires captured money, narrowed to its charge. */
export const paidPaymentReferenceOf = (
  session: Pick<
    ValidatedPaymentSession,
    "id" | "paymentReference" | "provider"
  >,
): TaggedPaymentReference => {
  const reference = paymentReferenceOf(session);
  if (reference === null) {
    throw new Error("Paid session has no provider resource id");
  }
  return reference;
};

/** Whether a value is a {@link SessionRejection}. Only the exact variants with
 *  their fields count, so no invented shape can steer the payment flow. */
export const isSessionRejection = (
  value: unknown,
): value is SessionRejection => {
  if (
    !isRecord(value) ||
    typeof value.provider !== "string" ||
    !isPaymentProvider(value.provider) ||
    typeof value.sessionId !== "string" ||
    !isResourceId(value.sessionId)
  ) {
    return false;
  }
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
const malformedChargeRejection = (
  sessionId: string,
  paymentReference: string,
  provider: PaymentProviderType,
  paid: boolean,
  metadata: SessionMetadata,
): SessionRejection => ({
  metadata: extractSessionMetadata(metadata),
  paymentReference,
  provider,
  reason: "malformed_charge",
  refundable: paid && isResourceId(paymentReference),
  sessionId,
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
  provider: PaymentProviderType;
}): ValidatedPaymentSession | SessionRejection => {
  if (!isResourceId(fields.id)) {
    throw new Error("Payment session has an invalid provider resource id");
  }
  const charge = money(fields.amountTotal, fields.currency);
  if (charge === null) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail:
        `Session ${fields.id} carries a malformed charge (amount=${fields.amountTotal}, currency=${fields.currency})`,
    });
    return malformedChargeRejection(
      fields.id,
      fields.paymentReference,
      fields.provider,
      fields.paymentStatus === "paid",
      fields.metadata,
    );
  }
  // A paid charge must name the provider resource that captured it. A blank id
  // names no charge to refund, so a paid session with one is refused here
  // rather than persisted as an unrefundable booking. A free session carries
  // none.
  if (
    fields.paymentStatus === "paid" &&
    !isResourceId(fields.paymentReference)
  ) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `Paid session ${fields.id} is missing its provider resource id`,
    });
    return {
      provider: fields.provider,
      reason: "blank_reference",
      sessionId: fields.id,
    };
  }
  return {
    amountTotal: charge.amount,
    currency: charge.currency,
    ...(fields.createdAt !== undefined ? { createdAt: fields.createdAt } : {}),
    id: fields.id,
    metadata: extractSessionMetadata(fields.metadata),
    paymentReference: fields.paymentReference,
    paymentStatus: fields.paymentStatus,
    provider: fields.provider,
  };
};
