import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { SumUp } from "@sumup/sdk";
import { settings } from "#shared/db/settings.ts";
import {
  setSumupCheckoutId,
  storeSumupCheckout,
} from "#shared/db/sumup-checkouts.ts";
import {
  type PaymentAttemptConfig,
  paymentAttemptApi,
} from "#shared/payment-attempt.ts";
import { sumupApi } from "#shared/sumup.ts";
import { asSession } from "#test-utils/payment-session.ts";
import {
  makeSumupClient,
  SUMUP_META,
  setupSumupSuite,
  sumupCheckoutResponse,
  sumupSandboxFixture,
} from "#test-utils/sumup.ts";

type SumupConfig = Extract<PaymentAttemptConfig, { type: "sumup" }>;

const configA: SumupConfig = {
  apiKey: "sumup-key-a-private",
  currency: "GBP",
  merchantCode: "merchant-a",
  type: "sumup",
};

const configB: SumupConfig = {
  apiKey: "sumup-key-b-private",
  currency: "EUR",
  merchantCode: "merchant-b",
  type: "sumup",
};

const clientAMarker = "sumup-client-a-private";
const clientBMarker = "sumup-client-b-private";
const privateValues = [
  configA.apiKey,
  configB.apiKey,
  clientAMarker,
  clientBMarker,
];

interface CallBarrier<T> {
  enter: (value: T) => Promise<void>;
  entered: Promise<T>;
  release: () => void;
}

const callBarrier = <T>(): CallBarrier<T> => {
  const entered = Promise.withResolvers<T>();
  const released = Promise.withResolvers<void>();
  return {
    enter: async (value) => {
      entered.resolve(value);
      await released.promise;
    },
    entered: entered.promise,
    release: released.resolve,
  };
};

const expectNoPrivateValues = (value: unknown): void => {
  const serialized = JSON.stringify(value);
  for (const privateValue of privateValues) {
    expect(serialized).not.toContain(privateValue);
  }
};

describe("bound SumUp payment attempts", () => {
  const { errorSpy, loggedDebug } = setupSumupSuite();

  test("binds all settlement work to its captured configuration", async () => {
    await storeSumupCheckout("ref-a", SUMUP_META);
    await setSumupCheckoutId("ref-a", "checkout-a");
    await storeSumupCheckout("ref-b", SUMUP_META);
    await setSumupCheckoutId("ref-b", "checkout-b");

    const observedA = callBarrier<{ client: string; id: string }>();
    const observedB = callBarrier<{ client: string; id: string }>();
    const refunded = callBarrier<{
      client: string;
      merchantCode: string;
      transactionId: string;
    }>();
    const statusRead = callBarrier<{
      client: string;
      merchantCode: string;
      transactionId: string;
    }>();
    const clientKeys: string[] = [];

    const makeClient = (
      client: string,
      reference: string,
      observed: CallBarrier<{ client: string; id: string }>,
    ): SumUp =>
      makeSumupClient({
        get: async (id) => {
          await observed.enter({ client, id });
          return sumupCheckoutResponse({
            checkout_reference: reference,
            currency: reference === "ref-a" ? "GBP" : "EUR",
            transaction_id: `transaction-${reference}`,
            transactions: [
              {
                amount: 10,
                currency: reference === "ref-a" ? "GBP" : "EUR",
                id: `transaction-${reference}`,
                merchant_code: "MC123",
                status: "SUCCESSFUL",
              },
            ],
          });
        },
        refund: async (merchantCode, transactionId) => {
          await refunded.enter({ client, merchantCode, transactionId });
          throw new Error(`refund failed inside ${client}`);
        },
        txnGet: async (merchantCode, query) => {
          const transactionId = (query as { id: string }).id;
          await statusRead.enter({ client, merchantCode, transactionId });
          const fixture = await sumupSandboxFixture("refunded");
          return fixture.transaction_response;
        },
      });
    const clients = new Map<string, SumUp>([
      [configA.apiKey, makeClient(clientAMarker, "ref-a", observedA)],
      [configB.apiKey, makeClient(clientBMarker, "ref-b", observedB)],
    ]);
    using _client = stub(sumupApi, "getSumupClient", (apiKey?: string) => {
      if (!apiKey) throw new Error("SumUp attempt did not bind an API key");
      clientKeys.push(apiKey);
      const client = clients.get(apiKey);
      if (!client) throw new Error(`Unexpected SumUp API key: ${apiKey}`);
      return client;
    });

    settings.setForTest({
      currency: configA.currency,
      sumup_api_key: configA.apiKey,
      sumup_merchant_code: configA.merchantCode,
    });
    const attemptA = await paymentAttemptApi.bind(configA);
    const sessionPromise = attemptA.retrieveSession("ref-a");
    expect(await observedA.entered).toEqual({
      client: clientAMarker,
      id: "checkout-a",
    });

    settings.setForTest({
      currency: configB.currency,
      sumup_api_key: configB.apiKey,
      sumup_merchant_code: configB.merchantCode,
    });
    observedA.release();
    const sessionA = asSession(await sessionPromise);
    expect(sessionA).toEqual(
      expect.objectContaining({
        currency: "GBP",
        id: "ref-a",
        paymentReference: "transaction-ref-a",
      }),
    );

    const refundPromise = attemptA.refundPayment(sessionA.paymentReference);
    expect(await refunded.entered).toEqual({
      client: clientAMarker,
      merchantCode: configA.merchantCode,
      transactionId: "transaction-ref-a",
    });
    refunded.release();
    expect(await refundPromise).toBe(false);

    const statusPromise = attemptA.isPaymentRefunded(sessionA.paymentReference);
    expect(await statusRead.entered).toEqual({
      client: clientAMarker,
      merchantCode: configA.merchantCode,
      transactionId: "transaction-ref-a",
    });
    statusRead.release();
    expect(await statusPromise).toBe(true);

    const attemptB = await paymentAttemptApi.bind(configB);
    const sessionBPromise = attemptB.retrieveSession("ref-b");
    expect(await observedB.entered).toEqual({
      client: clientBMarker,
      id: "checkout-b",
    });
    observedB.release();
    const sessionB = asSession(await sessionBPromise);
    expect(sessionB).toEqual(
      expect.objectContaining({
        currency: "EUR",
        id: "ref-b",
        paymentReference: "transaction-ref-b",
      }),
    );
    expect(clientKeys).toEqual([configA.apiKey, configB.apiKey]);

    expectNoPrivateValues(sessionA);
    expectNoPrivateValues(sessionB);
    expectNoPrivateValues(attemptA);
    expectNoPrivateValues(attemptB);
    for (const privateValue of privateValues) {
      expect(errorSpy.contains(privateValue)).toBe(false);
      expect(loggedDebug(privateValue)).toBe(false);
    }
  });

  test("keeps its captured currency after settings change", async () => {
    using _client = stub(sumupApi, "getSumupClient", () => makeSumupClient({}));
    const attempt = await paymentAttemptApi.bind({
      ...configA,
      currency: "JPY",
    });

    settings.setForTest({ currency: "GBP" });

    expect(attempt.currency).toBe("JPY");
  });

  test("refuses to bind without an API key", async () => {
    using _client = stub(sumupApi, "getSumupClient", () => null);

    await expect(
      paymentAttemptApi.bind({ ...configA, apiKey: "" }),
    ).rejects.toThrow("SumUp API key is required");
  });
});
