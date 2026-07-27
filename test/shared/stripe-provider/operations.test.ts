import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import { stripeApi } from "#shared/stripe.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  stripeCheckoutSession,
  stripeClient,
  stripeRefund,
} from "#test/lib/stripe/fixtures.ts";
import { describeStripe } from "#test/lib/stripe/harness.ts";
import { stubPersistedStripeRefund } from "#test/lib/stripe/provider-fixtures.ts";
import {
  CHARGE_RESOURCE,
  REFUND_RESOURCE,
} from "#test/shared/db/payments/fixtures.ts";
import { paymentCharge } from "#test/shared/payment-runtime/fixtures.ts";
import {
  checkoutIntent,
  checkoutItem,
  preparedCheckout,
} from "#test-utils/checkout.ts";
import { withMocks } from "#test-utils/mocks.ts";

const pendingCharge = () =>
  paymentCharge({
    pendingRefund: REFUND_RESOURCE,
    providerReference: CHARGE_RESOURCE,
    refunded: { amount: 0, currency: "GBP" },
    refundState: "pending",
  });

describe("Stripe refunds", () => {
  test("returns the exact pending refund resource from the initial response", async () => {
    await withMocks(
      () =>
        stub(stripeApi, "requestRefund", () =>
          Promise.resolve(stripeRefund({ status: "pending" })),
        ),
      async () => {
        expect(
          await stripePaymentProvider.refundCharge(
            paymentCharge({ providerReference: CHARGE_RESOURCE }),
            "refund-key",
          ),
        ).toEqual({
          amount: { amount: 1_000, currency: "GBP" },
          refund: REFUND_RESOURCE,
          status: "pending",
        });
      },
    );
  });

  for (const [name, refund] of [
    ["id", stripeRefund({ id: "refund-wrong" })],
    ["parent", stripeRefund({ payment_intent: "pi_other" })],
    ["amount", stripeRefund({ amount: 999 })],
    ["currency", stripeRefund({ currency: "eur" })],
  ] as const) {
    test(`rejects an initial refund with the wrong ${name}`, async () => {
      await withMocks(
        () => stub(stripeApi, "requestRefund", () => Promise.resolve(refund)),
        async () => {
          await expect(
            stripePaymentProvider.refundCharge(
              paymentCharge({ providerReference: CHARGE_RESOURCE }),
              "refund-key",
            ),
          ).rejects.toThrow();
        },
      );
    });
  }

  test("polls one persisted pending refund through success without another POST", async () => {
    const values = [
      stripeRefund({ status: "pending" }),
      stripeRefund({ status: "succeeded" }),
    ];
    await withMocks(
      () => stubPersistedStripeRefund(() => values.shift()!),
      async ({ create, retrieve }) => {
        expect(
          await stripePaymentProvider.refundCharge(
            pendingCharge(),
            "existing-key",
          ),
        ).toMatchObject({ refund: REFUND_RESOURCE, status: "pending" });
        expect(
          await stripePaymentProvider.refundCharge(
            pendingCharge(),
            "existing-key",
          ),
        ).toEqual({
          amount: { amount: 1_000, currency: "GBP" },
          refund: REFUND_RESOURCE,
          status: "completed",
        });
        expect(retrieve.calls.map((call) => call.args)).toEqual([
          [REFUND_RESOURCE.id],
          [REFUND_RESOURCE.id],
        ]);
        expect(create.calls).toHaveLength(0);
      },
    );
  });

  test("polls one persisted pending refund through provider failure", async () => {
    await withMocks(
      () => stubPersistedStripeRefund(() => stripeRefund({ status: "failed" })),
      async ({ create }) => {
        expect(
          await stripePaymentProvider.refundCharge(
            pendingCharge(),
            "existing-key",
          ),
        ).toEqual({
          amount: { amount: 0, currency: "GBP" },
          reason: "provider_failed",
          refund: REFUND_RESOURCE,
          status: "failed",
        });
        expect(create.calls).toHaveLength(0);
      },
    );
  });

  test("keeps a transient refund lookup pending", async () => {
    await withMocks(
      () =>
        stub(stripeApi, "retrieveRefund", () =>
          Promise.resolve({ status: "unavailable" as const }),
        ),
      async () => {
        expect(
          await stripePaymentProvider.refundCharge(
            pendingCharge(),
            "existing-key",
          ),
        ).toMatchObject({ refund: REFUND_RESOURCE, status: "pending" });
      },
    );
  });

  for (const [status, expected] of [
    ["requires_action", "pending"],
    ["canceled", "failed"],
  ] as const) {
    test(`maps an initial ${status} refund to ${expected}`, async () => {
      await withMocks(
        () =>
          stub(stripeApi, "requestRefund", () =>
            Promise.resolve(stripeRefund({ status })),
          ),
        async () => {
          expect(
            await stripePaymentProvider.refundCharge(
              paymentCharge({ providerReference: CHARGE_RESOURCE }),
              "refund-key",
            ),
          ).toMatchObject({ refund: REFUND_RESOURCE, status: expected });
        },
      );
    });
  }

  test("fails loudly for malformed persisted or returned refund data", async () => {
    await expect(
      stripePaymentProvider.refundCharge(
        paymentCharge({
          pendingRefund: { ...REFUND_RESOURCE, id: "refund-invalid" },
          providerReference: CHARGE_RESOURCE,
          refundState: "pending",
        }),
        "existing-key",
      ),
    ).rejects.toThrow();

    await withMocks(
      () =>
        stub(stripeApi, "retrieveRefund", () =>
          Promise.resolve({ status: "invalid" as const }),
        ),
      async () => {
        await expect(
          stripePaymentProvider.refundCharge(pendingCharge(), "existing-key"),
        ).rejects.toThrow("returned invalid data");
      },
    );
  });

  test("returns a typed failure when Stripe creates no refund", async () => {
    await withMocks(
      () => stub(stripeApi, "requestRefund", () => Promise.resolve(null)),
      async () => {
        expect(
          await stripePaymentProvider.refundCharge(
            paymentCharge({ providerReference: CHARGE_RESOURCE }),
            "refund-key",
          ),
        ).toMatchObject({ reason: "provider_failed", status: "failed" });
      },
    );
  });
});

describeStripe("Stripe checkout identity", () => {
  test("returns null when Stripe creates no Checkout Session", async () => {
    await withMocks(
      () => stub(stripeApi, "createCheckout", () => Promise.resolve(null)),
      async () => {
        expect(
          await stripePaymentProvider.createCheckout(await preparedCheckout()),
        ).toBeNull();
      },
    );
  });

  test("uses the local payment ID for metadata and idempotency", async () => {
    await settings.update.bookingFee("5");
    const client = await stripeClient();
    const create = stub(client.checkout.sessions, "create", () =>
      Promise.resolve(stripeCheckoutSession()),
    );
    await withMocks(
      () => create,
      async () => {
        const checkout = await preparedCheckout(
          checkoutIntent({ items: [checkoutItem({ quantity: 2 })] }),
          "stripe",
          "local-payment-123",
        );
        expect(await stripePaymentProvider.createCheckout(checkout)).toEqual({
          checkoutUrl: stripeCheckoutSession().url,
          session: {
            id: stripeCheckoutSession().id,
            kind: "stripe_checkout_session",
            provider: "stripe",
          },
          sessionId: stripeCheckoutSession().id,
        });
      },
    );

    const [params, key] = create.calls[0]!.args;
    expect(key).toBe("local-payment-123");
    expect(params.metadata.payment_id).toBe("local-payment-123");
    expect(params.success_url).toBe(
      "http://localhost:3000/payment/success?payment_id=local-payment-123&session_id={CHECKOUT_SESSION_ID}",
    );
    expect(params.cancel_url).toBe(
      "http://localhost:3000/payment/cancel?payment_id=local-payment-123&session_id={CHECKOUT_SESSION_ID}",
    );
    expect(
      params.line_items.map((item) => item.price_data.product_data),
    ).toEqual([
      { description: "2 Tickets", name: "Ticket: General" },
      { name: "Booking fee" },
    ]);
  });

  test("keeps a canonical payment ID already present in metadata", async () => {
    const client = await stripeClient();
    using _create = stub(client.checkout.sessions, "create", (_params) =>
      Promise.resolve(stripeCheckoutSession()),
    );
    const checkout = await preparedCheckout();
    checkout.metadata.payment_id = checkout.localPaymentId;

    await stripePaymentProvider.createCheckout(checkout);

    expect(_create.calls[0]?.args[0].metadata.payment_id).toBe(
      checkout.localPaymentId,
    );
  });
});
