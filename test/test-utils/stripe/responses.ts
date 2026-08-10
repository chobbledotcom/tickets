const checkout = {
  amount_total: 1000,
  created: 123,
  currency: "gbp",
  id: "cs_1",
  metadata: {},
  payment_intent: "pi_1",
  payment_status: "paid",
  url: "https://checkout.stripe.com/c/pay/cs_1",
};

/** A Stripe payment intent whose charge states its money, as the refund guard
 *  reads it. `returned` says how much has already gone back. */
export const stripeIntentWithCharge = (
  returned = 0,
  captured = 1000,
): {
  id: string;
  latest_charge: {
    amount: number;
    amount_refunded: number;
    currency: string;
    refunded: boolean;
  };
} => ({
  id: "pi_1",
  latest_charge: {
    amount: captured,
    amount_refunded: returned,
    currency: "gbp",
    refunded: returned >= captured,
  },
});

/** Return valid Stripe fixtures for every operation used by the application. */
export const stripeResponseFor = (path: string, method: string): Response => {
  if (path === "/v1/balance") return Response.json({ livemode: false });
  if (path === "/v1/refunds") {
    return Response.json({ id: "re_1", status: "succeeded" });
  }
  if (path.startsWith("/v1/payment_intents/")) {
    return Response.json(stripeIntentWithCharge());
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
