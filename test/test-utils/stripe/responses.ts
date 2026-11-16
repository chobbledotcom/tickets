import type { ProviderRead } from "#payment/provider-read.ts";
import type {
  StripeCheckoutSession,
  StripeExpandedPaymentIntent,
} from "#shared/stripe/schemas.ts";
import {
  stripeCheckoutSession,
  stripeFirstInvoice,
  stripePaidInvoice,
  stripeRefund,
  stripeSubscription,
} from "#test-utils/stripe/fixtures.ts";

const checkout = stripeCheckoutSession({
  id: "cs_1",
  payment_intent: "pi_1",
  url: "https://checkout.stripe.com/c/pay/cs_1",
});

/**
 * A checkout session as `retrieveCheckoutSession` hands it back. Stripe's real
 * response carries every field; a test names only the ones its exercised path
 * reads, so an omitted field stays absent at runtime exactly as the raw stub
 * did. The one unsafe cast lives here, not at every call site.
 */
export const stubCheckoutSession = (
  fields: Partial<StripeCheckoutSession>,
): StripeCheckoutSession => ({ ...fields }) as StripeCheckoutSession;

/** A Stripe payment intent whose charge states its money, as the refund guard
 *  reads it. `returned` says how much has already gone back. */
export const stripeIntentWithCharge = (
  returned = 0,
  captured = 1000,
): {
  id: string;
  latest_charge: {
    amount_captured: number;
    amount_refunded: number;
    captured: boolean;
    currency: string;
    paid: boolean;
    status: "succeeded";
  };
} => ({
  id: "pi_1",
  latest_charge: {
    amount_captured: captured,
    amount_refunded: returned,
    captured: true,
    currency: "gbp",
    paid: true,
    status: "succeeded",
  },
});

/** A provider read of one Stripe intent before any money has come back. */
export const foundStripeIntent = (
  paymentReference: string,
  capturedAmount: number,
): ProviderRead<StripeExpandedPaymentIntent> => ({
  resource: {
    ...stripeIntentWithCharge(0, capturedAmount),
    id: paymentReference,
  },
  status: "found",
});

const RESOURCE_REPLIES: readonly (readonly [string, () => unknown])[] = [
  ["/v1/subscriptions/", stripeSubscription],
  ["/v1/invoices/", stripeFirstInvoice],
  ["/v1/payment_intents/", stripeIntentWithCharge],
];

/** Return valid Stripe fixtures for every operation used by the application. */
export const stripeResponseFor = (path: string, method: string): Response => {
  if (path === "/v1/balance") return Response.json({ livemode: false });
  if (path === "/v1/refunds") {
    return Response.json(stripeRefund());
  }
  if (path === "/v1/invoices") {
    return Response.json({ data: [stripePaidInvoice()], has_more: false });
  }
  for (const [prefix, reply] of RESOURCE_REPLIES) {
    if (path.startsWith(prefix)) return Response.json(reply());
  }
  if (
    path === "/v1/checkout/sessions" ||
    path.startsWith("/v1/checkout/sessions/")
  ) {
    return Response.json(checkout);
  }
  if (path === "/v1/webhook_endpoints" && method === "GET") {
    return Response.json({
      data: [
        {
          enabled_events: ["checkout.session.completed"],
          id: "we_1",
          status: "enabled",
          url: "https://example.com/payment/webhook",
        },
      ],
      has_more: false,
    });
  }
  if (path.startsWith("/v1/webhook_endpoints") && method === "DELETE") {
    return Response.json({ deleted: true, id: "we_1" });
  }
  if (path.startsWith("/v1/webhook_endpoints")) {
    return Response.json({ id: "we_1", secret: "whsec_1" });
  }
  throw new Error(`Unexpected Stripe test request: ${method} ${path}`);
};
