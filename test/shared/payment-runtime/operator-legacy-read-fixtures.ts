import { buildPiiBlob, encryptPiiBlob } from "#shared/db/attendees/pii.ts";
import { prepareLegacyAttendeePaymentReference } from "#shared/db/payments/legacy-copy.ts";
import type { LegacyPaymentReplay } from "#shared/db/payments/legacy-sessions.ts";
import { settings } from "#shared/db/settings.ts";
import type { PaymentAccount } from "#shared/payment-runtime/account.ts";
import { readLegacyProviderReference } from "#shared/payment-runtime/operator-legacy-read.ts";
import type { LegacyProviderAssignmentRead } from "#shared/payment-state/operator.ts";
import type { SquarePayment } from "#shared/square-payments.ts";
import type { SumupTransaction } from "#shared/sumup.ts";
import type { PaymentProviderType } from "#shared/types.ts";
import { required } from "#test-utils/required.ts";
import { withTestSession } from "#test-utils/session.ts";

export const account = (
  provider: PaymentProviderType,
  mode: "live" | "test" = "test",
): PaymentAccount => ({ accountId: `${provider}-account`, mode, provider });

export const legacyPayment = async (
  reference: string,
): Promise<LegacyPaymentReplay> => {
  const prepared = required(
    await prepareLegacyAttendeePaymentReference(42, reference),
    "the legacy payment",
  );
  return {
    accountId: null,
    attendeeId: 42,
    id: prepared.id,
    mode: null,
    provider: null,
    revision: 1,
    runtime: prepared.runtime,
    state: "needs_action",
  };
};

export const legacyAttendeeBlobPayment = async (
  paymentId: string,
): Promise<LegacyPaymentReplay> => {
  const payment = await legacyPayment("temporary-reference");
  const attendeePayment = required(
    payment.runtime.attendeePayment,
    "the attendee payment",
  );
  payment.runtime = {
    ...payment.runtime,
    attendeePayment: {
      ...attendeePayment,
      paymentReference: await encryptPiiBlob(
        buildPiiBlob({
          address: "1 Legacy Street",
          email: "legacy@example.com",
          lat: "",
          lng: "",
          name: "Legacy attendee",
          payment_id: paymentId,
          phone: "07123456789",
          special_instructions: "Private note",
          ticket_token: "legacy-ticket",
        }),
        settings.publicKey,
      ),
      source: "attendees.pii_blob",
    },
  };
  return payment;
};

export const read = (
  payment: LegacyPaymentReplay,
  account: PaymentAccount,
): Promise<LegacyProviderAssignmentRead> =>
  withTestSession(() => readLegacyProviderReference(payment, account));

export const squarePayment = (
  reference: string,
  changes: Partial<SquarePayment> = {},
): SquarePayment => ({
  amountMoney: { amount: BigInt(1_000), currency: "GBP" },
  createdAt: "2026-07-26T12:00:00.000Z",
  id: reference,
  locationId: "location-one",
  orderId: "square-order",
  status: "COMPLETED",
  ...changes,
});

export const sumupTransaction = (
  reference: string,
  changes: Partial<SumupTransaction> = {},
): SumupTransaction => ({
  amount: { amount: 1_000, currency: "GBP" },
  id: reference,
  merchantCode: "merchant-one",
  refunded: { amount: 100, currency: "GBP" },
  refunds: [],
  status: "SUCCESSFUL",
  timestamp: "2026-07-26T12:00:00.000Z",
  ...changes,
});
