import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { REFUND_NETWORK_RETRIES } from "#payment/refund-network.ts";
import { providerDetail, transportError } from "#payment/transport-error.ts";
import { stripeApi } from "#shared/stripe.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { withMocks } from "#test-utils/mocks.ts";
import { gbp } from "#test-utils/payment-state.ts";
import {
  stripeApiError,
  stripeChargeMoney,
  stripeClient,
  stripeRefund,
  stripeRefundRequest,
} from "#test-utils/stripe/fixtures.ts";
import { describeStripe } from "#test-utils/stripe/harness.ts";

describeStripe("Stripe refund outcomes", () => {
  test("names an unconfigured provider without sending", async () => {
    expect(await stripeApi.refundCharge(stripeRefundRequest())).toEqual({
      kind: "not_sent",
      reason: "not_configured",
    });
  });

  for (const [status, expected] of [
    ["succeeded", "completed"],
    ["pending", "accepted"],
    ["requires_action", "accepted"],
  ] as const) {
    test(`maps ${status} to ${expected} with named proof`, async () => {
      const client = await stripeClient();
      await withMocks(
        () =>
          stub(client.refunds, "create", () =>
            Promise.resolve(
              stripeRefund({
                id: `re_${status}`,
                payment_intent: "pi_refund",
                status,
              }),
            ),
          ),
        async () => {
          expect(
            await stripeApi.refundCharge(stripeRefundRequest("pi_refund")),
          ).toEqual({
            amount: gbp(1000),
            kind: expected,
            proof: {
              kind: "named_refund",
              refund: {
                id: `re_${status}`,
                kind: "stripe_refund",
                parentId: "pi_refund",
                provider: "stripe",
              },
            },
          });
        },
      );
    });
  }

  for (const status of ["failed", "canceled"] as const) {
    test(`maps ${status} to a definite rejection`, async () => {
      const client = await stripeClient();
      await withMocks(
        () =>
          stub(client.refunds, "create", () =>
            Promise.resolve(
              stripeRefund({
                payment_intent: "pi_refund",
                status,
              }),
            ),
          ),
        async () => {
          expect(
            await stripeApi.refundCharge(stripeRefundRequest("pi_refund")),
          ).toEqual({ kind: "rejected", reason: status });
        },
      );
    });
  }

  test("sends the exact idempotency key carried by durable authority", async () => {
    const client = await stripeClient();
    const create = stub(client.refunds, "create", () =>
      Promise.resolve(stripeRefund({ payment_intent: "pi_stable" })),
    );
    await withMocks(
      () => create,
      async () => {
        expect(
          await stripeApi.refundCharge(
            stripeRefundRequest(
              "pi_stable",
              1000,
              "GBP",
              "persisted-refund-generation-one",
            ),
          ),
        ).toHaveProperty("kind", "completed");
      },
    );
    expect(create.calls[0]?.args).toEqual([
      { amount: 1000, payment_intent: "pi_stable" },
      "persisted-refund-generation-one",
      { maxNetworkRetries: REFUND_NETWORK_RETRIES.stripe },
    ]);
  });

  test("sends the exact amount admitted from the charge reading", async () => {
    const client = await stripeClient();
    const create = stub(client.refunds, "create", () =>
      Promise.resolve(
        stripeRefund({ amount: 731, payment_intent: "pi_exact" }),
      ),
    );
    await withMocks(
      () => create,
      async () => {
        expect(
          await stripeApi.refundCharge(stripeRefundRequest("pi_exact", 731)),
        ).toHaveProperty("kind", "completed");
      },
    );
    expect(create.calls[0]?.args[0]).toEqual({
      amount: 731,
      payment_intent: "pi_exact",
    });
  });

  for (const [refund, reason] of [
    [
      stripeRefund({ amount: 999, payment_intent: "pi_refund" }),
      "mismatched_money",
    ],
    [
      stripeRefund({ amount: -1, payment_intent: "pi_refund" }),
      "malformed_money",
    ],
    [
      stripeRefund({ currency: "usd", payment_intent: "pi_refund" }),
      "mismatched_money",
    ],
    [stripeRefund({ payment_intent: "pi_other" }), "mismatched_parent"],
    [
      stripeRefund({ payment_intent: "pi_refund", status: null }),
      "unsupported_status",
    ],
  ] as const) {
    test(`refuses a refund answer with ${reason}`, async () => {
      const client = await stripeClient();
      await withMocks(
        () => stub(client.refunds, "create", () => Promise.resolve(refund)),
        async () => {
          expect(
            await stripeApi.refundCharge(stripeRefundRequest("pi_refund")),
          ).toEqual({ kind: "uncertain", reason });
        },
      );
    });
  }

  for (const [error, reason] of [
    [stripeApiError(408), "timeout"],
    [stripeApiError(409), "provider_error"],
    [stripeApiError(429), "rate_limited"],
    [stripeApiError(500), "provider_error"],
    [stripeApiError(504), "timeout"],
    [
      transportError.unreachable(providerDetail.stripe(), "network_error"),
      "network_error",
    ],
    [transportError.unreachable(providerDetail.stripe(), "timeout"), "timeout"],
    [transportError.unusable(providerDetail.stripe()), "malformed_response"],
  ] as const) {
    test(`classifies an uncertain ${reason} answer`, async () => {
      const client = await stripeClient();
      await withMocks(
        () => stub(client.refunds, "create", () => Promise.reject(error)),
        async () => {
          expect(
            await stripeApi.refundCharge(stripeRefundRequest("pi_refund")),
          ).toEqual({ kind: "uncertain", reason });
        },
      );
    });
  }

  for (const status of [400, 402, 404]) {
    test(`treats an authoritative ${status} refusal as rejected`, async () => {
      const client = await stripeClient();
      await withMocks(
        () =>
          stub(client.refunds, "create", () =>
            Promise.reject(stripeApiError(status)),
          ),
        async () => {
          expect(
            await stripeApi.refundCharge(stripeRefundRequest("pi_refund")),
          ).toEqual({ kind: "rejected", reason: "rejected" });
        },
      );
    });
  }

  test("keeps a malformed 400 error body as a definite rejection", async () => {
    const client = await stripeClient();
    const protocol = transportError.unusable(providerDetail.stripe(), 400);
    await withMocks(
      () => stub(client.refunds, "create", () => Promise.reject(protocol)),
      async () => {
        expect(
          await stripeApi.refundCharge(stripeRefundRequest("pi_refund")),
        ).toEqual({ kind: "rejected", reason: "rejected" });
      },
    );
  });

  test("lets unexpected implementation errors propagate", async () => {
    const client = await stripeClient();
    await withMocks(
      () =>
        stub(client.refunds, "create", () =>
          Promise.reject(new TypeError("broken adapter")),
        ),
      async () => {
        await expect(
          stripeApi.refundCharge(stripeRefundRequest("pi_refund")),
        ).rejects.toThrow("broken adapter");
      },
    );
  });

  test("delegates a rejection and its fresh read through the adapter", async () => {
    const request = stripeRefundRequest("pi_refund");
    const answer = { kind: "rejected", reason: "rejected" } as const;
    using refund = stub(stripeApi, "refundCharge", () =>
      Promise.resolve(answer),
    );
    using read = stub(stripePaymentProvider, "readCharge", () =>
      Promise.resolve({ resource: stripeChargeMoney(), status: "found" }),
    );
    expect(await stripePaymentProvider.refundCharge(request)).toEqual(answer);
    expect(refund.calls[0]?.args).toEqual([request]);
    expect(read.calls[0]?.args).toEqual([request.paymentReference]);
  });
});
