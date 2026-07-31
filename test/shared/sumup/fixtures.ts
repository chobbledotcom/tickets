import { afterEach, beforeEach } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";
import type { SumUp } from "@sumup/sdk";
import { createPaymentSession } from "#shared/db/payments/sessions.ts";
import type { PaymentSession } from "#shared/db/payments/types.ts";
import { settings } from "#shared/db/settings.ts";
import type { PaymentCheckoutCreateSnapshot } from "#shared/payment-checkout.ts";
import { resolvePaymentAccount } from "#shared/payment-runtime/account.ts";
import type {
  ProviderChargeResource,
  ProviderSessionResource,
} from "#shared/payment-state/resources.ts";
import {
  type SumupCheckout,
  type SumupReadResult,
  type SumupTransaction,
  sumupApi,
} from "#shared/sumup.ts";
import {
  PAYMENT_INTENT,
  PAYMENT_TIME,
} from "#test/shared/db/payments/fixtures.ts";
import { preparedCheckout } from "#test-utils/checkout.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withMocks } from "#test-utils/mocks.ts";

export const SUMUP_CHECKOUT_TIME = "2026-07-26T12:00:00.000Z";
export const SUMUP_TRANSACTION_TIME = "2026-07-26T12:01:00.000Z";
export const SUMUP_LOCAL_PAYMENT_ID = "sumup-local";
export const SUMUP_MERCHANT_CODE = "MC123";
export const SUMUP_MONEY = { amount: 1_000, currency: "GBP" } as const;

export const sumupCheckoutResource: ProviderSessionResource = {
  id: "sumup-checkout",
  kind: "sumup_checkout",
  provider: "sumup",
};

export const sumupTransactionResource: ProviderChargeResource = {
  id: "sumup-transaction",
  kind: "sumup_transaction",
  parentId: sumupCheckoutResource.id,
  provider: "sumup",
};

/** One buyer wanting one place, priced and ready to send to SumUp. */
export const sumupCheckoutSnapshot = (
  localPaymentId = SUMUP_LOCAL_PAYMENT_ID,
): Promise<PaymentCheckoutCreateSnapshot> =>
  preparedCheckout(
    {
      address: "",
      date: null,
      email: "alice@example.com",
      items: [
        {
          listingId: 1,
          name: "Event",
          quantity: 1,
          slug: "event",
          unitPrice: SUMUP_MONEY.amount,
        },
      ],
      name: "Alice",
      phone: "",
      special_instructions: "",
    },
    "sumup",
    localPaymentId,
  );

export const describeSumup = (name: string, body: () => void): void =>
  describeWithEnv(name, { db: true }, () => {
    beforeEach(() => {
      settings.setForTest({
        currency: SUMUP_MONEY.currency,
        sumup_api_key: "sk_test_sumup",
        sumup_merchant_code: SUMUP_MERCHANT_CODE,
      });
    });
    afterEach(() => settings.clearTestOverrides());
    body();
  });

export const sumupCheckout = (
  changes: Partial<SumupCheckout> = {},
): SumupCheckout => ({
  amountMinor: SUMUP_MONEY.amount,
  createdAt: SUMUP_CHECKOUT_TIME,
  currency: SUMUP_MONEY.currency,
  id: sumupCheckoutResource.id,
  merchantCode: SUMUP_MERCHANT_CODE,
  reference: SUMUP_LOCAL_PAYMENT_ID,
  status: "PAID",
  transactionId: sumupTransactionResource.id,
  ...changes,
});

export const sumupTransaction = (
  changes: Partial<SumupTransaction> = {},
): SumupTransaction => ({
  amount: SUMUP_MONEY,
  id: sumupTransactionResource.id,
  merchantCode: SUMUP_MERCHANT_CODE,
  refunded: { amount: 0, currency: SUMUP_MONEY.currency },
  refunds: [],
  status: "SUCCESSFUL",
  timestamp: SUMUP_TRANSACTION_TIME,
  ...changes,
});

export const sumupCheckoutResponse = (
  changes: Record<string, unknown> = {},
): Record<string, unknown> => {
  const checkout = sumupCheckout({
    id: "co_1",
    reference: "ref",
    status: "PENDING",
    transactionId: undefined,
  });
  return {
    amount: checkout.amountMinor / 100,
    checkout_reference: checkout.reference,
    currency: checkout.currency,
    date: checkout.createdAt,
    id: checkout.id,
    merchant_code: checkout.merchantCode,
    status: checkout.status,
    ...changes,
  };
};

export const sumupTransactionResponse = (
  changes: Record<string, unknown> = {},
): Record<string, unknown> => {
  const transaction = sumupTransaction({ id: "txn_1" });
  return {
    amount: transaction.amount.amount / 100,
    currency: transaction.amount.currency,
    id: transaction.id,
    merchant_code: transaction.merchantCode,
    status: transaction.status,
    timestamp: transaction.timestamp,
    ...changes,
  };
};

const foundRead = <Value>(value: Value): Promise<SumupReadResult<Value>> =>
  Promise.resolve({ status: "found", value });

export const foundSumupCheckout = (
  changes: Partial<SumupCheckout> = {},
): ReturnType<typeof sumupApi.retrieveCheckoutById> =>
  foundRead(sumupCheckout(changes));

export const foundSumupTransaction = (
  changes: Partial<SumupTransaction> = {},
): ReturnType<typeof sumupApi.getTransactionStatus> =>
  foundRead(sumupTransaction(changes));

export const refundCompletesOnSecondRead =
  (): typeof sumupApi.getTransactionStatus => {
    let reads = 0;
    return () => {
      reads++;
      return foundSumupTransaction({
        refunded: {
          amount: reads === 1 ? 0 : SUMUP_MONEY.amount,
          currency: SUMUP_MONEY.currency,
        },
        status: reads === 1 ? "SUCCESSFUL" : "REFUNDED",
      });
    };
  };

type SumupClientStub = Stub<
  typeof sumupApi,
  Parameters<typeof sumupApi.getSumupClient>,
  ReturnType<typeof sumupApi.getSumupClient>
>;

export const stubSumupClient = (client: unknown): SumupClientStub =>
  stub(sumupApi, "getSumupClient", () => client as SumUp);

export const withSumupMerchantClient = (
  get: (merchantCode: string) => Promise<unknown>,
  body: () => Promise<void>,
): Promise<void> =>
  withMocks(() => stubSumupClient({ merchants: { get } }), body);

interface SumupProviderMethods {
  checkout?: typeof sumupApi.retrieveCheckoutById;
  refund?: typeof sumupApi.refundTransaction;
  transaction?: typeof sumupApi.getTransactionStatus;
}

type CheckoutStub = Stub<
  typeof sumupApi,
  Parameters<typeof sumupApi.retrieveCheckoutById>,
  ReturnType<typeof sumupApi.retrieveCheckoutById>
>;
type RefundStub = Stub<
  typeof sumupApi,
  Parameters<typeof sumupApi.refundTransaction>,
  ReturnType<typeof sumupApi.refundTransaction>
>;
type TransactionStub = Stub<
  typeof sumupApi,
  Parameters<typeof sumupApi.getTransactionStatus>,
  ReturnType<typeof sumupApi.getTransactionStatus>
>;

export interface SumupProviderFixture extends Disposable {
  checkout: CheckoutStub;
  refund: RefundStub;
  transaction: TransactionStub;
}

export const stubSumupProvider = (
  methods: SumupProviderMethods = {},
): SumupProviderFixture => {
  const checkout = stub(
    sumupApi,
    "retrieveCheckoutById",
    methods.checkout ?? (() => foundSumupCheckout()),
  );
  const transaction = stub(
    sumupApi,
    "getTransactionStatus",
    methods.transaction ?? (() => foundSumupTransaction()),
  );
  const refund = stub(
    sumupApi,
    "refundTransaction",
    methods.refund ?? (() => Promise.resolve({ status: "accepted" })),
  );
  return {
    checkout,
    refund,
    transaction,
    [Symbol.dispose]: () => {
      refund.restore();
      transaction.restore();
      checkout.restore();
    },
  };
};

export const createStoredSumupPayment = async (
  session: ProviderSessionResource | null = sumupCheckoutResource,
): Promise<PaymentSession> => {
  const account = await resolvePaymentAccount("sumup");
  return await createPaymentSession(
    {
      accountId: account.accountId,
      bookingIntent: PAYMENT_INTENT,
      checkoutCreate: null,
      expected: SUMUP_MONEY,
      id: SUMUP_LOCAL_PAYMENT_ID,
      mode: account.mode,
      provider: "sumup",
      session,
    },
    PAYMENT_TIME,
  );
};
