/** Provider stubs for rejected-session refund tests: select Stripe, answer
 * its refund calls, and build the signed rejection this instance owns. */

import { expect } from "@std/expect";
import { spy, stub } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import type {
  RefundAttemptResult,
  RefundRequest,
} from "#shared/payment/refund-attempt.ts";
import type { MalformedRejection } from "#shared/payment/validated-session.ts";
import type { SessionMetadata } from "#shared/payments.ts";
import { paymentsApi } from "#shared/payments.ts";
import { stripeApi } from "#shared/stripe.ts";
import type { PaymentProviderType } from "#shared/types.ts";
import { completedStripeRefund } from "#test/test-utils/stripe/fixtures.ts";
import { signedMeta } from "#test-utils/factories.ts";
import { foundStripeIntent } from "#test-utils/stripe/responses.ts";

/** Run `body` with the site configured for `selected` payments — the real
 *  settings value the configured-provider read consults — while holding the
 *  Stripe key an existing Stripe payment's refund still needs. */
export const withProviderSelected = async <T>(
  selected: PaymentProviderType,
  body: () => Promise<T>,
): Promise<T> => {
  settings.setForTest({
    payment_provider: selected,
    stripe_secret_key: "sk_test_rejected_charge",
  });
  try {
    return await body();
  } finally {
    settings.clearTestOverrides();
  }
};

/** Run `body` and prove it never reached Stripe — spies keep the real
 *  methods, so a call would leave for the provider and be counted here. */
export const withStripeProvider = (run: () => Promise<void>): Promise<void> =>
  withProviderSelected("stripe", async () => {
    const refundSpy = spy(stripeApi, "refundCharge");
    const intentSpy = spy(stripeApi, "readPaymentIntent");
    try {
      await run();
      expect(refundSpy.calls.length).toBe(0);
      expect(intentSpy.calls.length).toBe(0);
    } finally {
      refundSpy.restore();
      intentSpy.restore();
    }
  });

/** Run `body` with Stripe's refund answering `answer`, handing back what it
 *  returned and the arguments the refund was actually called with. Stubbed,
 *  not spied: a spy keeps the real method, so the refund would leave for
 *  Stripe itself. */
export const withRefundAnswering =
  (
    answer: (request: RefundRequest) => RefundAttemptResult,
    capturedAmount = 500,
    selectedProvider: PaymentProviderType = "stripe",
  ) =>
  async <T>(
    body: () => Promise<T>,
  ): Promise<{ calls: unknown[][]; result: T }> => {
    const refundStub = stub(stripeApi, "refundCharge", (request) =>
      Promise.resolve(answer(request)),
    );
    // The refund asks what the money has already done before sending any, so
    // the charge must read as one nothing has come back on for the refund to
    // be admitted at all.
    const intentStub = stub(stripeApi, "readPaymentIntent", (reference) =>
      Promise.resolve(foundStripeIntent(reference, capturedAmount)),
    );
    try {
      const result = await withProviderSelected(selectedProvider, body);
      return { calls: refundStub.calls.map((call) => call.args), result };
    } finally {
      intentStub.restore();
      refundStub.restore();
    }
  };

export const withSucceedingRefundFor = (
  capturedAmount: number,
): ReturnType<typeof withRefundAnswering> =>
  withRefundAnswering(
    (request) =>
      completedStripeRefund(
        request.paymentReference,
        "re_settled",
        request.charge.captured.amount,
      ),
    capturedAmount,
  );

/** A refundable malformed-charge rejection this instance signed, so its
 *  ownership check passes and the refund goes ahead. Metadata overrides let
 *  a test carry real booking lines. */
export const ourRejection = (
  paymentReference: string,
  metadata: Partial<SessionMetadata> = {},
): MalformedRejection => ({
  metadata: signedMeta(
    { email: "a@example.com", items: "[]", name: "A", ...metadata },
    500,
  ),
  paymentReference,
  provider: "stripe" as const,
  reason: "malformed_charge" as const,
  refundable: true,
  sessionId: `cs_${paymentReference}`,
});
