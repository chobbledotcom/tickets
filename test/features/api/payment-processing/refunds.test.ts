import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { tryRefund } from "#routes/api/payment-processing/refunds.ts";
import { getPaymentCharges } from "#shared/db/payments/charges.ts";
import { stripeApi } from "#shared/stripe.ts";
import {
  paymentCallback,
  startCurrentPayment,
} from "#test/shared/payment-runtime/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupStripe } from "#test-utils/settings.ts";

describeWithEnv("tryRefund", { db: true }, () => {
  test("returns false without calling any provider when paymentReference is empty", async () => {
    expect(
      await tryRefund({
        amountTotal: 0,
        id: "session-empty-reference",
        metadata: {
          _origin: "",
          address: "",
          allocations: "",
          answer_ids: "",
          balance_attendee_id: "",
          date: "",
          day_count: "",
          email: "",
          items: "",
          modifiers: "",
          name: "",
          phone: "",
          price_proof: "",
          reservation_amount: "",
          site_token_index: "",
          special_instructions: "",
          text_answer_ids: "",
          thank_you_url: "",
        },
        paymentReference: "",
        paymentStatus: "paid",
      }),
    ).toBe(false);
  });

  test("uses the current payment refund and records provider success", async () => {
    await setupStripe();
    await startCurrentPayment();
    using refund = stub(stripeApi, "refundPayment", () =>
      Promise.resolve({ status: "succeeded" } as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >),
    );

    expect(await tryRefund(paymentCallback())).toBe(true);
    expect(refund.calls).toHaveLength(1);
    expect((await getPaymentCharges("local-payment-1"))[0]).toMatchObject({
      pendingRefundIdempotencyKey: null,
      refunded: { amount: 1_000, currency: "GBP" },
      refundState: "completed",
    });
  });

  test("keeps the current refund request when the provider cannot confirm it", async () => {
    await setupStripe();
    await startCurrentPayment();
    using _refund = stub(stripeApi, "refundPayment", () =>
      Promise.resolve(null),
    );
    using _intent = stub(stripeApi, "retrievePaymentIntent", () =>
      Promise.resolve({ latest_charge: { refunded: false } } as Awaited<
        ReturnType<typeof stripeApi.retrievePaymentIntent>
      >),
    );

    expect(await tryRefund(paymentCallback())).toBe(false);
    expect((await getPaymentCharges("local-payment-1"))[0]).toMatchObject({
      refundState: "requested",
    });
  });
});
