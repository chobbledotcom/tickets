/* jscpd:ignore-start -- imports */
import { decryptWithOwnerKey } from "#shared/crypto/keys.ts";
import { parsePiiBlob } from "#shared/db/attendees/pii.ts";
import type { LegacyPaymentReplay } from "#shared/db/payments/legacy-sessions.ts";
import { settings } from "#shared/db/settings.ts";
import type { PaymentAccount } from "#shared/payment-runtime/account.ts";
import { PAYMENT_PROVIDER_RESOURCES } from "#shared/payment-runtime/current.ts";
import type { LegacyProviderAssignmentRead } from "#shared/payment-state/operator.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { type SquareResourceRead, squareApi } from "#shared/square.ts";
import {
  type SquarePayment,
  squarePaymentMoneyOrNull,
} from "#shared/square-payments.ts";
import type { StripeLookupResult } from "#shared/stripe/runtime.ts";
import type { StripeExpandedPaymentIntent } from "#shared/stripe/schemas.ts";
import { stripeApi } from "#shared/stripe.ts";
import {
  type SumupReadResult,
  type SumupTransaction,
  sumupApi,
} from "#shared/sumup.ts";
import type { PaymentProviderType } from "#shared/types.ts";

/* jscpd:ignore-end */

const legacyReference = async (
  payment: LegacyPaymentReplay,
): Promise<string> => {
  const processed = payment.runtime.processedPayment?.paymentReference;
  const encrypted =
    processed || payment.runtime.attendeePayment?.paymentReference;
  if (encrypted === undefined || encrypted === "") {
    throw new Error(`Legacy payment ${payment.id} has no provider reference`);
  }
  const decrypted = await decryptWithOwnerKey(
    encrypted,
    await requireRequestPrivateKey(),
  );
  const attendee = payment.runtime.attendeePayment;
  if (
    (processed !== undefined && processed !== "") ||
    attendee?.source !== "attendees.pii_blob"
  ) {
    return decrypted;
  }
  const paymentId = parsePiiBlob(decrypted).pi;
  if (paymentId === "") {
    throw new Error(`Legacy payment ${payment.id} has no provider reference`);
  }
  return paymentId;
};

type LegacyReadResult<Value> =
  | SquareResourceRead<Value>
  | StripeLookupResult<Value>
  | SumupReadResult<Value>;

type LegacyReader = (
  reference: string,
  account: PaymentAccount,
  payment: LegacyPaymentReplay,
) => Promise<LegacyProviderAssignmentRead>;

const defineLegacyReader =
  <Value>(
    provider: string,
    load: (reference: string) => Promise<LegacyReadResult<Value>>,
    readFound: (
      value: Value,
      reference: string,
      account: PaymentAccount,
      payment: LegacyPaymentReplay,
    ) => LegacyProviderAssignmentRead,
  ): LegacyReader =>
  async (reference, account, payment) => {
    const result = await load(reference);
    if ("value" in result) {
      return readFound(result.value, reference, account, payment);
    }
    if (result.status === "missing") return { status: "missing" };
    if (result.status === "unavailable") {
      throw new Error(`${provider} could not check the older payment`);
    }
    return { status: "ambiguous" };
  };

type AttachedLegacyRead = Extract<
  LegacyProviderAssignmentRead,
  { status: "attached" }
>;
type LegacyPaymentMoney = Pick<AttachedLegacyRead, "captured" | "refunded">;

const attachedLegacyRead = (
  money: LegacyPaymentMoney,
  charge: AttachedLegacyRead["charge"],
  session: AttachedLegacyRead["session"],
): AttachedLegacyRead => ({ ...money, charge, session, status: "attached" });

const readSquarePayment = (
  payment: SquarePayment,
  reference: string,
  account: PaymentAccount,
): LegacyProviderAssignmentRead => {
  const money = squarePaymentMoneyOrNull(payment);
  if (
    payment.id !== reference ||
    payment.status !== "COMPLETED" ||
    payment.locationId !== settings.square.locationId ||
    money === null ||
    account.mode !== (settings.square.sandbox ? "test" : "live")
  ) {
    return { status: "ambiguous" };
  }
  if (payment.orderId === undefined) {
    return { ...money, status: "reviewed" };
  }
  const session = PAYMENT_PROVIDER_RESOURCES.square.session(payment.orderId);
  return attachedLegacyRead(
    money,
    PAYMENT_PROVIDER_RESOURCES.square.charge(reference, session.id),
    session,
  );
};

const readStripePayment = (
  intent: StripeExpandedPaymentIntent,
  reference: string,
  account: PaymentAccount,
  payment: LegacyPaymentReplay,
): LegacyProviderAssignmentRead => {
  const charge = intent.latest_charge;
  if (
    intent.id !== reference ||
    intent.status !== "succeeded" ||
    charge === null ||
    charge.payment_intent !== reference ||
    !charge.paid ||
    !charge.captured ||
    charge.amount_captured <= 0 ||
    intent.amount_received !== charge.amount_captured ||
    charge.currency !== intent.currency ||
    charge.livemode !== intent.livemode ||
    account.mode !== (intent.livemode ? "live" : "test")
  ) {
    return { status: "ambiguous" };
  }
  const money = {
    captured: {
      amount: charge.amount_captured,
      currency: charge.currency.toUpperCase(),
    },
    refunded: {
      amount: charge.amount_refunded,
      currency: charge.currency.toUpperCase(),
    },
  };
  const stage = payment.runtime.checkoutStage;
  if (stage === null || stage.provider !== "stripe") {
    return { ...money, status: "reviewed" };
  }
  const session = PAYMENT_PROVIDER_RESOURCES.stripe.session(
    stage.paymentSessionId,
  );
  return attachedLegacyRead(
    money,
    PAYMENT_PROVIDER_RESOURCES.stripe.charge(intent.id, session.id),
    session,
  );
};

const matchesSumupAccount = (
  transaction: SumupTransaction,
  account: PaymentAccount,
): boolean =>
  transaction.merchantCode === settings.sumup.merchantCode &&
  (transaction.status === "SUCCESSFUL" || transaction.status === "REFUNDED") &&
  account.mode === settings.sumup.keyMode;

const readSumupPayment = (
  transaction: SumupTransaction,
  reference: string,
  account: PaymentAccount,
  payment: LegacyPaymentReplay,
): LegacyProviderAssignmentRead => {
  if (
    transaction.id !== reference ||
    !matchesSumupAccount(transaction, account)
  ) {
    return { status: "ambiguous" };
  }
  const money = {
    captured: transaction.amount,
    refunded: transaction.refunded,
  };
  const checkout = payment.runtime.sumupCheckout;
  if (checkout === null || checkout.sumupId === "") {
    return { ...money, status: "reviewed" };
  }
  const session = PAYMENT_PROVIDER_RESOURCES.sumup.session(checkout.sumupId);
  return attachedLegacyRead(
    money,
    PAYMENT_PROVIDER_RESOURCES.sumup.charge(reference, session.id),
    session,
  );
};

const readSquareReference = defineLegacyReader(
  "Square",
  (reference) => squareApi.readPayment(reference),
  readSquarePayment,
);
const readStripeReference = defineLegacyReader(
  "Stripe",
  (reference) => stripeApi.lookupPaymentIntent(reference),
  readStripePayment,
);
const readSumupReference = defineLegacyReader(
  "SumUp",
  (reference) => sumupApi.getTransactionStatus(reference),
  readSumupPayment,
);

const legacyReaders: Record<PaymentProviderType, LegacyReader> = {
  square: readSquareReference,
  stripe: readStripeReference,
  sumup: readSumupReference,
};

/** Read one owner-decrypted legacy charge through the selected typed provider API. */
export const readLegacyProviderReference = async (
  payment: LegacyPaymentReplay,
  account: PaymentAccount,
): Promise<LegacyProviderAssignmentRead> =>
  legacyReaders[account.provider](
    await legacyReference(payment),
    account,
    payment,
  );
