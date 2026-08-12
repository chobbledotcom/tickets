import { expect } from "@std/expect";
import { type Stub, stub } from "@std/testing/mock";
import type { SessionMetadata } from "#shared/payments.ts";
import type { StripeCheckoutSession } from "#shared/stripe/schemas.ts";
import { stripeApi } from "#shared/stripe.ts";
import { signedMeta } from "#test-utils/factories.ts";
import { stubWebhookVerify } from "#test-utils/settings.ts";
import { answerCompletedStripeRefund } from "#test-utils/stripe/fixtures.ts";
import { foundStripeIntent } from "#test-utils/stripe/responses.ts";
import { postWebhookAndAssert } from "#test-utils/webhooks.ts";

type CheckoutSessionStub = Stub<
  typeof stripeApi,
  Parameters<typeof stripeApi.retrieveCheckoutSession>,
  ReturnType<typeof stripeApi.retrieveCheckoutSession>
>;

type RefundChargeStub = Stub<
  typeof stripeApi,
  Parameters<typeof stripeApi.refundCharge>,
  ReturnType<typeof stripeApi.refundCharge>
>;

export interface StripeRefundStub extends Disposable {
  readonly calls: RefundChargeStub["calls"];
  restore(): void;
}

type CheckoutSessionDetails = {
  amountTotal: number;
  paymentIntent: string | null;
  paymentStatus?: StripeCheckoutSession["payment_status"];
  sessionId: string;
} & (
  | {
      metadata: SessionMetadata | StripeCheckoutSession["metadata"];
    }
  | { email: string; items: string; name: string }
);

const copyMetadata = (
  metadata: SessionMetadata | StripeCheckoutSession["metadata"],
): StripeCheckoutSession["metadata"] => {
  if (metadata === null) return null;
  return Object.fromEntries(Object.entries(metadata));
};

/** Stub the Stripe session read used by payment redirects. */
export const stubRetrieveCheckoutSession = (
  session: CheckoutSessionDetails,
): CheckoutSessionStub => {
  const metadata =
    "metadata" in session
      ? copyMetadata(session.metadata)
      : signedMeta(
          {
            email: session.email,
            items: session.items,
            name: session.name,
          },
          session.amountTotal,
        );
  const response: StripeCheckoutSession = {
    amount_total: session.amountTotal,
    created: 1_700_000_000,
    currency: "gbp",
    id: session.sessionId,
    metadata,
    payment_intent: session.paymentIntent,
    payment_status: session.paymentStatus ?? "paid",
    url: null,
  };
  return stub(stripeApi, "retrieveCheckoutSession", () =>
    Promise.resolve(response),
  );
};

/** Stub a successful Stripe refund and its independent payment read. */
export const stubRefundPayment = (
  refundId = "re_test",
  capturedAmount = 1000,
): StripeRefundStub => {
  const read = stub(stripeApi, "readPaymentIntent", (paymentReference) =>
    Promise.resolve(foundStripeIntent(paymentReference, capturedAmount)),
  );
  const refund = stub(
    stripeApi,
    "refundCharge",
    answerCompletedStripeRefund(refundId),
  );
  let active = true;
  const restore = (): void => {
    if (!active) return;
    active = false;
    refund.restore();
    read.restore();
  };
  return {
    get calls() {
      return refund.calls;
    },
    restore,
    [Symbol.dispose](): void {
      restore();
    },
  };
};

/** Process a Stripe webhook that must keep the booking and refund it. */
export const expectWebhookKeptAndRefunded = async (
  event: Parameters<typeof stubWebhookVerify>[0],
  refundId = "re_test",
  errorContains: string | string[] = "saved your details",
  signature?: string,
): Promise<{ mockRefund: StripeRefundStub }> => {
  const amount = event.data.object.amount_total;
  if (typeof amount !== "number") {
    throw new Error("A refunded Stripe test event must state amount_total");
  }
  const mockVerify = await stubWebhookVerify(event);
  const mockRefund = stubRefundPayment(refundId, amount);
  await postWebhookAndAssert(
    () => {
      mockVerify.restore();
      mockRefund.restore();
    },
    200,
    (json) => {
      expect(json.received).toBe(true);
      expect(json.processed).toBe(false);
      for (const substring of Array.isArray(errorContains)
        ? errorContains
        : [errorContains]) {
        expect(json.error).toContain(substring);
      }
    },
    signature ?? "sig_valid",
  );
  return { mockRefund };
};
