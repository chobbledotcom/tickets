import { money } from "#payment/money.ts";
import {
  type TaggedPaymentReference,
  taggedPaymentReference,
} from "#payment/provider-reference.ts";
import { isResourceId } from "#payment/resource-id.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { extractSessionMetadata } from "#shared/payment-helpers.ts";
import type {
  PaymentProviderType,
  SessionMetadata,
  ValidatedPaymentSession,
} from "#shared/payments.ts";
import { isPaymentProvider, isRecord } from "#types";

/**
 * Both refusal types retain metadata and the observed subscription. The callback
 * must prove ownership before it stops future charges. Only a
 * `malformed_charge` can name captured money to refund.
 */
export type SessionRejection = {
  metadata: SessionMetadata;
  createdAt?: string;
  subscription?: ValidatedPaymentSession["subscription"];
} & (
  | {
      reason: "malformed_charge";
      paymentReference: string;
      provider: PaymentProviderType;
      refundable: boolean;
      sessionId: string;
    }
  | {
      provider: PaymentProviderType;
      reason: "blank_reference";
      sessionId: string;
    }
);

/** A rejection that still names a real provider charge. */
export type MalformedRejection = Extract<
  SessionRejection,
  { reason: "malformed_charge" }
>;

/** The session fields that prove a charge identity: its own id, the provider
 * resource id, and the provider. Both charge-reference readers take this
 * slice, so the repeated `Pick` lives once. */
type SessionPaymentReference = Pick<
  ValidatedPaymentSession,
  "id" | "paymentReference" | "provider"
>;

/** The durable charge identity proved by a validated session, or no charge for
 * a free checkout. A non-empty invalid id contradicts the session boundary and
 * fails where it is turned into storage/provider input. */
export const paymentReferenceOf = (
  session: SessionPaymentReference,
): TaggedPaymentReference | null => {
  if (session.paymentReference === "") return null;
  if (!isResourceId(session.paymentReference)) {
    throw new Error("Validated session has an invalid provider resource id");
  }
  return taggedPaymentReference(session.provider, session.paymentReference);
};

/** A session path that requires captured money, narrowed to its charge. */
export const paidPaymentReferenceOf = (
  session: SessionPaymentReference,
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
    !isResourceId(value.sessionId) ||
    typeof value.metadata !== "object" ||
    value.metadata === null
  ) {
    return false;
  }
  if (value.reason === "blank_reference") return true;
  return (
    value.reason === "malformed_charge" &&
    typeof value.paymentReference === "string" &&
    typeof value.refundable === "boolean"
  );
};

/** The malformed-charge refusal, refundable only when money was captured AND
 *  the provider named it. The metadata is unpacked first: Square folds its
 *  small fields into one entry, but the price proof is signed over the
 *  unpacked shape. Without the unpacking, a packed record fails its own
 *  ownership check, and no Square charge is refunded. */
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

const withRejectedSubscription = (
  rejection: SessionRejection,
  subscription: ValidatedPaymentSession["subscription"],
  createdAt: string | undefined,
): SessionRejection => {
  if (subscription !== undefined) {
    rejection.subscription = subscription;
    if (createdAt !== undefined) rejection.createdAt = createdAt;
  }
  return rejection;
};

/**
 * The one place a provider's raw session becomes a ValidatedPaymentSession, so
 * every callback downstream reads a charge that was already checked.
 *
 * `metadata` must already pass hasRequiredSessionMetadata, or come from
 * our own staged checkout row. A charge in a currency other than the site's is
 * NOT refused here: it is built. The callbacks treat it as a price mismatch,
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
  subscription?: ValidatedPaymentSession["subscription"];
}): ValidatedPaymentSession | SessionRejection => {
  if (!isResourceId(fields.id)) {
    throw new Error("Payment session has an invalid provider resource id");
  }
  const charge = money(fields.amountTotal, fields.currency);
  if (charge === null) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `Session ${fields.id} carries a malformed charge (amount=${fields.amountTotal}, currency=${fields.currency})`,
    });
    return withRejectedSubscription(
      malformedChargeRejection(
        fields.id,
        fields.paymentReference,
        fields.provider,
        fields.paymentStatus === "paid",
        fields.metadata,
      ),
      fields.subscription,
      fields.createdAt,
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
    return withRejectedSubscription(
      {
        metadata: extractSessionMetadata(fields.metadata),
        provider: fields.provider,
        reason: "blank_reference",
        sessionId: fields.id,
      },
      fields.subscription,
      fields.createdAt,
    );
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
    ...(fields.subscription === undefined
      ? {}
      : { subscription: fields.subscription }),
  };
};
