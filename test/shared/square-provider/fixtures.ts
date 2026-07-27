import { createPaymentSession } from "#shared/db/payments/sessions.ts";
import type { PaymentSession } from "#shared/db/payments/types.ts";
import { resolvePaymentAccount } from "#shared/payment-runtime/account.ts";
import type { ProviderRead } from "#shared/payment-state/observation.ts";
import type { SquareResourceRead } from "#shared/square.ts";
import type { SquareOrder, SquarePayment } from "#shared/square-payments.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import {
  PAYMENT_INTENT,
  PAYMENT_TIME,
} from "#test/shared/db/payments/fixtures.ts";
import {
  configureSquare,
  withSquareClient,
} from "#test/test-utils/square/fixtures.ts";
import { required } from "#test-utils/required.ts";

export const session = {
  id: "order-typed",
  kind: "square_order" as const,
  provider: "square" as const,
};
export const squareLocation = "square-location";
export const exactPayment = {
  id: "pay-typed",
  kind: "square_payment" as const,
  parentId: session.id,
  provider: "square" as const,
};

export type UnresolvedSquareRead = Exclude<
  SquareResourceRead<never>,
  { status: "found" }
>;

export const unresolvedSquareReads: ReadonlyArray<{
  name: "invalid" | "missing" | "unavailable";
  read: UnresolvedSquareRead;
}> = [
  { name: "missing", read: { status: "missing" } },
  { name: "unavailable", read: { status: "unavailable" } },
  {
    name: "invalid",
    read: { reason: "mismatched_id", status: "invalid" },
  },
];

export const squarePayment = async (): Promise<PaymentSession> => {
  const account = await resolvePaymentAccount("square");
  return await createPaymentSession(
    {
      accountId: account.accountId,
      bookingIntent: PAYMENT_INTENT,
      checkoutCreate: null,
      expected: { amount: 1_000, currency: "GBP" },
      id: "square-local",
      mode: account.mode,
      provider: "square",
      session,
    },
    PAYMENT_TIME,
  );
};

export const orderResponse = (
  paymentIds = ["pay-typed"],
): { order: SquareOrder } => ({
  order: {
    createdAt: "2026-07-26T10:00:00.000Z",
    id: session.id,
    locationId: squareLocation,
    state: "OPEN",
    tenders: paymentIds.map((paymentId) => ({ paymentId })),
    totalMoney: { amount: 1_000n, currency: "GBP" },
  },
});

export const foundOrder = (
  changes: Partial<SquareOrder> = {},
): Extract<SquareResourceRead<SquareOrder>, { status: "found" }> => ({
  status: "found",
  value: { ...orderResponse().order, ...changes },
});

/** What Square is taken to be saying about a payment, given how it answers
 *  about the order and about the location's payments. */
export const squareReadWith = async (
  impls: Parameters<typeof withSquareClient>[0],
  requested: Parameters<typeof squarePaymentProvider.readPayment>[1] = session,
): Promise<ProviderRead> => {
  await configureSquare({ locationId: squareLocation, sandbox: true });
  let read: ProviderRead | undefined;
  await withSquareClient(impls, async () => {
    read = await squarePaymentProvider.readPayment(
      await squarePayment(),
      requested,
    );
  });
  return required(read, "the Square read");
};

export const paymentResponse = (id: string): { payment: SquarePayment } => ({
  payment: {
    amountMoney: { amount: 1_000n, currency: "GBP" },
    createdAt: "2026-07-26T10:00:01.000Z",
    id,
    locationId: squareLocation,
    orderId: session.id,
    status: "COMPLETED",
  },
});
