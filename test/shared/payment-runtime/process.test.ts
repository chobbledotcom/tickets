import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getDb } from "#shared/db/client.ts";
import { getPaymentCharges } from "#shared/db/payments/charges.ts";
import {
  createPaymentSession,
  getPaymentSessions,
} from "#shared/db/payments/sessions.ts";
import { settings } from "#shared/db/settings.ts";
import { resolvePaymentAccount } from "#shared/payment-runtime/account.ts";
import {
  type PaymentReconcileOutcome,
  reconcilePayment,
} from "#shared/payment-runtime/process.ts";
import { providerFactDetails } from "#shared/payment-runtime/provider-read.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import { stripeApi } from "#shared/stripe.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { sumupPaymentProvider } from "#shared/sumup-provider.ts";
import {
  PAYMENT_ID,
  PAYMENT_INTENT,
  paymentSessionInput,
  SESSION_RESOURCE,
} from "#test/shared/db/payments/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  completePayment,
  createPendingPayment,
  getStoredPayment,
  paymentProviderRead,
} from "./fixtures.ts";

const locator = { kind: "provider" as const, resource: SESSION_RESOURCE };

describeWithEnv("payment reconciliation", { db: true }, () => {
  test("stores provider facts before fulfilment", async () => {
    await createPendingPayment();
    using read = stub(stripePaymentProvider, "readPayment", () =>
      Promise.resolve(paymentProviderRead()),
    );
    let stateDuringFulfilment = "";

    const outcome = await reconcilePayment("stripe", locator, async (work) => {
      stateDuringFulfilment = (await getStoredPayment()).state;
      return completePayment(work);
    });

    expect(outcome.status).toBe("fulfilled");
    expect(stateDuringFulfilment).toBe("processing");
    expect(read.calls).toHaveLength(1);
    expect(await getPaymentCharges(PAYMENT_ID)).toMatchObject([
      {
        captured: { amount: 1_000, currency: "GBP" },
        providerReference: { id: "pi_test_1" },
      },
    ]);
  });

  test("replays a terminal payment without provider IO", async () => {
    await createPendingPayment();
    using read = stub(stripePaymentProvider, "readPayment", () =>
      Promise.resolve(paymentProviderRead()),
    );
    let fulfilments = 0;
    const fulfil = async (
      work: Parameters<Parameters<typeof reconcilePayment>[2]>[0],
    ) => {
      fulfilments++;
      return completePayment(work);
    };
    await reconcilePayment("stripe", locator, fulfil);

    const replay = await reconcilePayment("stripe", locator, fulfil);

    expect(replay).toMatchObject({ replayed: true, status: "completed" });
    expect(read.calls).toHaveLength(1);
    expect(fulfilments).toBe(1);
  });

  test("adopts a signed pre-aggregate provider session once", async () => {
    const adoptedId = "adopted:stripe:cs_test_1";
    using read = stub(stripePaymentProvider, "readPayment", (payment) =>
      Promise.resolve(
        paymentProviderRead({
          ownership:
            payment === null
              ? {
                  localPaymentId: adoptedId,
                  method: "signed",
                  signature: "signed-metadata",
                }
              : {
                  localPaymentId: payment.id,
                  method: "staged",
                  stageId: SESSION_RESOURCE.id,
                },
        }),
      ),
    );

    const first = await reconcilePayment("stripe", locator, completePayment);
    const second = await reconcilePayment("stripe", locator, completePayment);

    expect(first.status).toBe("fulfilled");
    expect(second).toMatchObject({ replayed: true, status: "completed" });
    const [stored] = await getPaymentSessions([adoptedId]);
    expect(stored?.session).toEqual(SESSION_RESOURCE);
    expect(read.calls).toHaveLength(1);
  });

  test("attaches a lost create response to its existing local payment", async () => {
    const created = await createPendingPayment({
      ...paymentSessionInput(PAYMENT_ID, null),
      session: null,
    });
    using read = stub(stripePaymentProvider, "readPayment", () =>
      Promise.resolve(
        paymentProviderRead({
          accountId: created.accountId,
          bookingIntent: {
            address: PAYMENT_INTENT.address,
            date: PAYMENT_INTENT.date,
            email: PAYMENT_INTENT.email,
            items: PAYMENT_INTENT.items,
            modifiers: PAYMENT_INTENT.modifiers,
            name: PAYMENT_INTENT.name,
            phone: PAYMENT_INTENT.phone,
            special_instructions: PAYMENT_INTENT.special_instructions,
          },
          ownership: {
            localPaymentId: created.id,
            method: "signed",
            signature: "signed-local-payment",
          },
        }),
      ),
    );

    const outcome = await reconcilePayment("stripe", locator, completePayment);

    expect(outcome.status).toBe("fulfilled");
    expect((await getStoredPayment()).session).toEqual(SESSION_RESOURCE);
    const rows = await getDb().execute(
      "SELECT id FROM payment_sessions ORDER BY id",
    );
    expect(rows.rows).toEqual([{ id: PAYMENT_ID }]);
    expect(read.calls).toHaveLength(1);
  });

  test("stores a conflict when signed ownership names another account", async () => {
    await createPendingPayment({
      ...paymentSessionInput(PAYMENT_ID, null),
      session: null,
    });
    using _read = stub(stripePaymentProvider, "readPayment", () =>
      Promise.resolve(
        paymentProviderRead({
          accountId: "different-provider-account",
          ownership: {
            localPaymentId: PAYMENT_ID,
            method: "signed",
            signature: "signed-local-payment",
          },
        }),
      ),
    );

    const outcome = await reconcilePayment("stripe", locator, completePayment);

    expect(outcome.status).toBe("conflict");
    expect((await getStoredPayment()).state).toBe("needs_action");
  });

  test("rejects a stored payment after switching Stripe accounts", async () => {
    let stripeAccountId = "acct_process_one";
    using _account = stub(stripeApi, "retrieveAccount", () =>
      Promise.resolve({ id: stripeAccountId }),
    );
    settings.setForTest({ stripe_secret_key: "sk_test_process_account_one" });
    const account = await resolvePaymentAccount("stripe");
    await createPaymentSession({
      ...paymentSessionInput(),
      accountId: account.accountId,
    });
    stripeAccountId = "acct_process_two";
    settings.setForTest({ stripe_secret_key: "sk_test_process_account_two" });
    using read = stub(stripePaymentProvider, "readPayment", () => {
      throw new Error("Wrong Stripe account must fail before payment lookup");
    });

    const outcome = await reconcilePayment("stripe", locator, completePayment);

    expect(outcome.status).toBe("conflict");
    expect(read.calls).toHaveLength(0);
    expect((await getStoredPayment()).state).toBe("needs_action");
  });

  test("attaches a returned SumUp id through its local checkout reference", async () => {
    settings.setForTest({
      payment_provider: "sumup",
      sumup_api_key: "sk_test_sumup",
      sumup_merchant_code: "merchant-one",
    });
    const account = await resolvePaymentAccount("sumup");
    const resource = {
      id: "sumup-returned-id",
      kind: "sumup_checkout" as const,
      provider: "sumup" as const,
    };
    await createPaymentSession({
      ...paymentSessionInput(PAYMENT_ID, null),
      accountId: account.accountId,
      mode: account.mode,
      provider: "sumup",
      session: null,
    });
    using _read = stub(sumupPaymentProvider, "readPayment", () =>
      Promise.resolve({
        observation: {
          accountId: account.accountId,
          bookingIntent: PAYMENT_INTENT,
          createdAt: "2026-07-26T12:00:00.000Z",
          expected: { amount: 1_000, currency: "GBP" },
          mode: account.mode,
          ownership: {
            localPaymentId: PAYMENT_ID,
            method: "staged" as const,
            stageId: resource.id,
          },
          providerTotal: { amount: 1_000, currency: "GBP" },
          session: resource,
          status: "pending" as const,
        },
        requested: resource,
        returned: resource,
        status: "found" as const,
      }),
    );

    const outcome = await reconcilePayment(
      "sumup",
      { kind: "provider", resource },
      completePayment,
    );

    expect(outcome.status).toBe("pending");
    expect((await getStoredPayment()).session).toEqual(resource);
  });

  test("stores missing provider creation time as invalid", async () => {
    await createPendingPayment();
    let providerError: Error | null = null;
    try {
      providerFactDetails(undefined, undefined);
    } catch (error) {
      if (error instanceof Error) providerError = error;
    }
    if (providerError === null)
      throw new Error("Expected invalid provider time");
    using _read = stub(stripePaymentProvider, "readPayment", () =>
      Promise.reject(providerError),
    );

    expect(
      (await reconcilePayment("stripe", locator, completePayment)).status,
    ).toBe("conflict");
    expect((await getStoredPayment()).state).toBe("needs_action");
  });

  test("uses the stored provider for a local redirect after settings switch", async () => {
    await createPendingPayment();
    using stripeRead = stub(stripePaymentProvider, "readPayment", () =>
      Promise.resolve(paymentProviderRead()),
    );
    using squareRead = stub(squarePaymentProvider, "readPayment", () => {
      throw new Error("Wrong provider used");
    });

    const outcome = await reconcilePayment(
      "square",
      { id: PAYMENT_ID, kind: "local" },
      completePayment,
    );

    expect(outcome.status).toBe("fulfilled");
    expect(stripeRead.calls).toHaveLength(1);
    expect(squareRead.calls).toHaveLength(0);
  });

  test("retries an unavailable verified provider resource without ownership", async () => {
    using _read = stub(stripePaymentProvider, "readPayment", () =>
      Promise.resolve({
        reason: "provider_unavailable" as const,
        requested: SESSION_RESOURCE,
        status: "unavailable" as const,
      }),
    );

    expect(
      (await reconcilePayment("stripe", locator, completePayment)).status,
    ).toBe("retry");
  });

  test("persists a retry case before returning retry", async () => {
    await createPendingPayment();
    using _read = stub(stripePaymentProvider, "readPayment", () =>
      Promise.resolve({
        ownership: {
          localPaymentId: PAYMENT_ID,
          method: "staged" as const,
          stageId: SESSION_RESOURCE.id,
        },
        reason: "timed_out" as const,
        requested: SESSION_RESOURCE,
        status: "unavailable" as const,
      }),
    );

    const outcome = await reconcilePayment("stripe", locator, completePayment);

    expect(outcome.status).toBe("retry");
    expect((await getStoredPayment()).state).toBe("pending");
    const cases = await getDb().execute(
      "SELECT reason, state FROM payment_cases WHERE payment_id = ?",
      [PAYMENT_ID],
    );
    expect(cases.rows).toEqual([{ reason: "timed_out", state: "retrying" }]);
  });

  test("persists a permanent money conflict", async () => {
    await createPendingPayment();
    using _read = stub(stripePaymentProvider, "readPayment", () =>
      Promise.resolve(
        paymentProviderRead({
          providerTotal: { amount: 900, currency: "GBP" },
        }),
      ),
    );

    expect(
      (await reconcilePayment("stripe", locator, completePayment)).status,
    ).toBe("conflict");
    expect((await getStoredPayment()).state).toBe("needs_action");
    const cases = await getDb().execute(
      "SELECT reason, state FROM payment_cases WHERE payment_id = ?",
      [PAYMENT_ID],
    );
    expect(cases.rows).toEqual([
      { reason: "provider_total_mismatch", state: "needs_action" },
    ]);
  });

  test("serializes concurrent redirect and webhook reconciliation", async () => {
    await createPendingPayment();
    using _read = stub(stripePaymentProvider, "readPayment", () =>
      Promise.resolve(paymentProviderRead()),
    );
    let release = (): void => {
      throw new Error("Concurrent payment was not held");
    };
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = reconcilePayment("stripe", locator, async (work) => {
      await held;
      return completePayment(work);
    });
    await Promise.resolve();
    await Promise.resolve();

    const second: PaymentReconcileOutcome = await reconcilePayment(
      "stripe",
      locator,
      completePayment,
    );
    expect(second.status).toBe("busy");
    release();
    expect((await first).status).toBe("fulfilled");
  });
});
